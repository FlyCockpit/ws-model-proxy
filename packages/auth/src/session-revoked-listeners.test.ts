import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "session-revoked-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
}));

// Callable-proxy Prisma stub (see user-deletion-listeners.test.ts): lets the
// real auth instance construct without a database.
function makePrismaStub(): unknown {
  return new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
}
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { notifySessionRevoked, onSessionRevoked } = await import("./session-revoked-listeners");
const { auth } = await import("./index");

const unsubscribes: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  vi.restoreAllMocks();
});

describe("session revoked listeners", () => {
  it("notifies every listener with the deleted session", async () => {
    const first = vi.fn();
    const second = vi.fn(async () => undefined);
    unsubscribes.push(onSessionRevoked(first), onSessionRevoked(second));
    await notifySessionRevoked({ id: "s1", userId: "u1" });
    expect(first).toHaveBeenCalledWith({ id: "s1", userId: "u1" });
    expect(second).toHaveBeenCalledWith({ id: "s1", userId: "u1" });
  });

  it("logs a failing listener without throwing or skipping the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const after = vi.fn();
    unsubscribes.push(
      onSessionRevoked(() => {
        throw new TypeError("boom");
      }),
      onSessionRevoked(async () => {
        throw new RangeError("later");
      }),
      onSessionRevoked(after),
    );
    await expect(notifySessionRevoked({ id: "s1", userId: "u1" })).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("[auth] session revoked listener failed", "TypeError");
    expect(error).toHaveBeenCalledWith("[auth] session revoked listener failed", "RangeError");
  });

  it("Better Auth's session delete.after hook reports the deleted session", async () => {
    const listener = vi.fn();
    unsubscribes.push(onSessionRevoked(listener));
    const after = auth.options.databaseHooks?.session?.delete?.after;
    expect(after).toBeTypeOf("function");
    await after?.({
      id: "s1",
      userId: "u1",
      token: "t",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ id: "s1", userId: "u1" });
  });
});
