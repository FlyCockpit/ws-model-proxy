import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "user-deletion-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
}));

// Callable-proxy Prisma stub (see auth-startup-schema.test.ts): lets the real
// auth instance construct without a database.
const makePrismaStub = (): unknown =>
  new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { notifyUserDeleted, onUserDeleted } = await import("./user-deletion-listeners");
const { auth } = await import("./index");

const unsubscribes: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  vi.restoreAllMocks();
});

describe("user deletion listeners", () => {
  it("notifies every listener with the deleted user id", async () => {
    const first = vi.fn();
    const second = vi.fn(async () => undefined);
    unsubscribes.push(onUserDeleted(first), onUserDeleted(second));
    await notifyUserDeleted("user-1");
    expect(first).toHaveBeenCalledWith("user-1");
    expect(second).toHaveBeenCalledWith("user-1");
  });

  it("registers the same listener once and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = onUserDeleted(listener);
    onUserDeleted(listener);
    await notifyUserDeleted("user-1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await notifyUserDeleted("user-2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("logs a failing listener without throwing or skipping the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const after = vi.fn();
    unsubscribes.push(
      onUserDeleted(() => {
        throw new TypeError("boom");
      }),
      onUserDeleted(after),
    );
    await expect(notifyUserDeleted("user-1")).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledWith("user-1");
    expect(error).toHaveBeenCalledWith("[auth] user deletion listener failed", "TypeError");
  });

  it("Better Auth's user.delete.after hook (admin remove-user) notifies listeners", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserDeleted(listener));
    const after = auth.options.databaseHooks?.user?.delete?.after;
    expect(after).toBeTypeOf("function");
    await after?.({
      id: "removed-user",
      email: "removed@example.com",
      emailVerified: true,
      name: "Removed",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(listener).toHaveBeenCalledWith("removed-user");
  });
});
