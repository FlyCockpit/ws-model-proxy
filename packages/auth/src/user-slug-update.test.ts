import { describe, expect, it, vi } from "vitest";

/**
 * The account slug names every callable ID of the person's pools (also in their share holders'
 * namespaces): only `settings.update` changes it, under the owner fences of everyone it renames
 * for (packages/api lib/model-names.ts). Better Auth's update routes refuse it.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "proved-email-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: "smtp.example.test",
  },
}));

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn(async () => ({ count: 1 })) }));
function makePrismaStub(): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
}
vi.mock("@ws-model-proxy/db", () => {
  const stub = makePrismaStub() as Record<string, unknown>;
  return {
    default: new Proxy(stub, {
      get(target, prop, receiver) {
        if (prop === "user") return { updateMany, findUnique: async () => null };
        if (prop === "shareInvite") return { findMany: async () => [] };
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => true),
}));

const { auth } = await import("./index");

const updateBefore = auth.options.databaseHooks?.user?.update?.before;

describe("account slug through Better Auth", () => {
  // The hook runs for every update route (`/update-user`, `/admin/update-user`, OAuth profile
  // sync); it looks only at the data.
  it("refuses a slug in any update", async () => {
    if (!updateBefore) throw new Error("user update before hook missing");
    await expect(updateBefore({ slug: "new-slug" })).rejects.toMatchObject({
      body: { code: "SLUG_CHANGE_UNSUPPORTED" },
    });
    await expect(updateBefore({ name: "New", slug: "new-slug" })).rejects.toMatchObject({
      body: { code: "SLUG_CHANGE_UNSUPPORTED" },
    });
  });

  it("lets every other update through", async () => {
    if (!updateBefore) throw new Error("user update before hook missing");
    await expect(updateBefore({ name: "New", emailVerified: true })).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
