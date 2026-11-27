import { describe, expect, it, vi } from "vitest";

/**
 * The account slug names every callable ID of the person's pools: only `settings.update`
 * changes it, checked against the person's own aliases under their owner fence (packages/api
 * lib/model-names.ts). Better Auth's update routes refuse it.
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
    await expect(updateBefore({ slug: "new-slug" }, null)).rejects.toMatchObject({
      body: { code: "SLUG_CHANGE_UNSUPPORTED" },
    });
    await expect(updateBefore({ name: "New", slug: "new-slug" }, null)).rejects.toMatchObject({
      body: { code: "SLUG_CHANGE_UNSUPPORTED" },
    });
  });

  // Reset and invite links carry only the user id: a link mailed to the old address must never
  // set the password of the account under a new one.
  it("refuses an e-mail change in any update", async () => {
    if (!updateBefore) throw new Error("user update before hook missing");
    await expect(updateBefore({ email: "new@example.test" }, null)).rejects.toMatchObject({
      body: { code: "EMAIL_CHANGE_UNSUPPORTED" },
    });
    await expect(
      updateBefore({ name: "New", email: "new@example.test" }, null),
    ).rejects.toMatchObject({
      body: { code: "EMAIL_CHANGE_UNSUPPORTED" },
    });
  });

  // An admin saying an address is verified proves nothing about the mailbox.
  it("refuses emailVerified from /admin/update-user", async () => {
    if (!updateBefore) throw new Error("user update before hook missing");
    for (const emailVerified of [true, false]) {
      await expect(
        updateBefore({ emailVerified }, { path: "/admin/update-user" } as never),
      ).rejects.toMatchObject({ body: { code: "EMAIL_VERIFICATION_BY_MAIL_ONLY" } });
    }
    await expect(
      updateBefore({ name: "New" }, { path: "/admin/update-user" } as never),
    ).resolves.toBeUndefined();
    // Better Auth's own verify-email route writes it on another path.
    await expect(
      updateBefore({ emailVerified: true }, { path: "/verify-email" } as never),
    ).resolves.toBeUndefined();
  });

  it("lets every other update through", async () => {
    if (!updateBefore) throw new Error("user update before hook missing");
    await expect(updateBefore({ name: "New", emailVerified: true }, null)).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
