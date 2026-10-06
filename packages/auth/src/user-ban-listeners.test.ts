import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "user-ban-test-secret-at-least-32-chars-long",
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
const userUpdate = vi.hoisted(() => vi.fn());
vi.mock("@ws-model-proxy/db", () => {
  const stub = makePrismaStub() as Record<string, unknown>;
  return {
    default: new Proxy(stub, {
      get(target, prop, receiver) {
        // `user.update` is the write Better Auth's internal adapter makes for a ban.
        if (prop === "user") return { update: userUpdate };
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { notifyUserBanned, onUserBanned } = await import("./user-ban-listeners");
const { auth } = await import("./index");

const unsubscribes: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  vi.restoreAllMocks();
});

describe("user ban listeners", () => {
  it("notifies every listener with the banned user id", async () => {
    const first = vi.fn();
    const second = vi.fn(async () => undefined);
    unsubscribes.push(onUserBanned(first), onUserBanned(second));
    await notifyUserBanned("user-1");
    expect(first).toHaveBeenCalledWith("user-1");
    expect(second).toHaveBeenCalledWith("user-1");
  });

  it("registers the same listener once and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = onUserBanned(listener);
    onUserBanned(listener);
    await notifyUserBanned("user-1");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await notifyUserBanned("user-2");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("logs a failing listener (sync throw or rejection) without throwing or skipping the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const after = vi.fn();
    unsubscribes.push(
      onUserBanned(() => {
        throw new TypeError("boom");
      }),
      onUserBanned(async () => {
        throw new RangeError("late");
      }),
      onUserBanned(after),
    );
    await expect(notifyUserBanned("user-1")).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledWith("user-1");
    expect(error).toHaveBeenCalledWith("[auth] user banned listener failed", "TypeError");
    expect(error).toHaveBeenCalledWith("[auth] user banned listener failed", "RangeError");
  });
});

describe("Better Auth user.update.after hook", () => {
  const row = (extra: Record<string, unknown>) => ({
    id: "banned-user",
    email: "banned@example.com",
    emailVerified: true,
    name: "Banned",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });
  const after = () => auth.options.databaseHooks?.user?.update?.after;

  it("is registered", () => {
    expect(after()).toBeTypeOf("function");
  });

  it.each([
    ["an indefinite ban", { banned: true, banExpires: null }],
    ["a ban without a stored expiry", { banned: true }],
    [
      "a temporary ban that has not expired",
      { banned: true, banExpires: new Date(Date.now() + 60_000) },
    ],
  ])("notifies for %s", async (_label, fields) => {
    const listener = vi.fn();
    unsubscribes.push(onUserBanned(listener));
    await after()?.(row(fields), null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("banned-user");
  });

  it.each([
    ["an unban", { banned: false, banExpires: null }],
    ["a never-banned user", { banned: null }],
    ["a user without the field", {}],
    ["an expired temporary ban", { banned: true, banExpires: new Date(Date.now() - 60_000) }],
    ["a non-boolean flag", { banned: "true" }],
  ])("does not notify for %s", async (_label, fields) => {
    const listener = vi.fn();
    unsubscribes.push(onUserBanned(listener));
    await after()?.(row(fields), null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores a missing row (the update matched nothing)", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserBanned(listener));
    await after()?.(null as never, null);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Better Auth's internal adapter, the write behind /admin/ban-user", () => {
  it("runs the after hook with the updated row, so a real ban write notifies", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserBanned(listener));
    userUpdate.mockResolvedValueOnce({
      id: "banned-user",
      email: "banned@example.com",
      emailVerified: true,
      name: "Banned",
      createdAt: new Date(),
      updatedAt: new Date(),
      banned: true,
      banReason: null,
      banExpires: null,
    });
    const context = await auth.$context;
    await context.internalAdapter.updateUser("banned-user", { banned: true });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("banned-user");
  });

  it("does not notify for an update that leaves the user unbanned", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserBanned(listener));
    userUpdate.mockResolvedValueOnce({
      id: "plain-user",
      email: "plain@example.com",
      emailVerified: true,
      name: "Renamed",
      createdAt: new Date(),
      updatedAt: new Date(),
      banned: false,
      banExpires: null,
    });
    const context = await auth.$context;
    await context.internalAdapter.updateUser("plain-user", { name: "Renamed" });
    expect(listener).not.toHaveBeenCalled();
  });
});
