import { getAuthTables } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mailbox proof (`User.provedEmail`, Codex finding 2): only the verify-email routes record it,
 * only with SMTP on, and no Better Auth route can write it.
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

const { hasProvedEmail, provedEmailKey } = await import("./proved-email");
const { auth } = await import("./index");

const updateAfter = auth.options.databaseHooks?.user?.update?.after;
type HookContext = Parameters<NonNullable<typeof updateAfter>>[1];
const user = {
  id: "u1",
  email: "Friend@Example.test",
  emailVerified: true,
  name: "Friend",
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function runUpdateAfter(path: string, row: typeof user = user): Promise<void> {
  if (!updateAfter) throw new Error("user update after hook missing");
  await updateAfter(row, { path } as unknown as HookContext);
}

beforeEach(() => updateMany.mockClear());

describe("mailbox proof", () => {
  it("holds only while the proved address is the account's address", () => {
    expect(provedEmailKey("  Friend@Example.TEST ")).toBe("friend@example.test");
    expect(
      hasProvedEmail({ email: "Friend@example.test", provedEmail: "friend@example.test" }),
    ).toBe(true);
    expect(hasProvedEmail({ email: "friend@example.test", provedEmail: null })).toBe(false);
    expect(hasProvedEmail({ email: "new@example.test", provedEmail: "friend@example.test" })).toBe(
      false,
    );
  });

  it("is recorded by the verify-email routes, guarded on the address being unchanged", async () => {
    for (const path of ["/verify-email", "/email-otp/verify-email"]) {
      updateMany.mockClear();
      await runUpdateAfter(path);
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: "u1", email: "Friend@Example.test" },
        data: { provedEmail: "friend@example.test" },
      });
    }
  });

  it("is not recorded by any other update (admin update-user included) or an unverified row", async () => {
    await runUpdateAfter("/admin/update-user");
    await runUpdateAfter("/update-user");
    await runUpdateAfter("/verify-email", { ...user, emailVerified: false });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("is not a Better Auth field, so no auth route can write it", () => {
    const additional = Object.keys(auth.options.user?.additionalFields ?? {});
    const userFields = Object.keys(getAuthTables(auth.options).user?.fields ?? {});
    expect(additional).not.toContain("provedEmail");
    expect(userFields).not.toContain("provedEmail");
  });
});
