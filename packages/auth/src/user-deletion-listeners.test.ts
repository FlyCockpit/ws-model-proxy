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
const {
  deleteUserDurably,
  findRetainedHistoryBlocker,
  requestUserDeletion,
  resolveDeletedParents,
} = vi.hoisted(() => ({
  deleteUserDurably: vi.fn(
    async (_db: unknown, _userId: string): Promise<"deleted" | "missing" | "pending"> => "deleted",
  ),
  findRetainedHistoryBlocker: vi.fn(async (): Promise<string | null> => null),
  requestUserDeletion: vi.fn(
    async (): Promise<{ generation: string; created: boolean } | null> => ({
      generation: "generation-1",
      created: true,
    }),
  ),
  resolveDeletedParents: vi.fn(async () => ({})),
}));
vi.mock("@ws-model-proxy/db/parent-deletion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/db/parent-deletion")>()),
  deleteUserDurably,
  findRetainedHistoryBlocker,
  requestUserDeletion,
  resolveDeletedParents,
}));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { notifyUserDeleted, notifyUserDeletionMarked, onUserDeleted, onUserDeletionMarked } =
  await import("./user-deletion-listeners");
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

  it("delivers deletion marks to marked listeners, isolates failures and unsubscribes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(() => {
      throw new TypeError("boom");
    });
    const marked = vi.fn();
    const deleted = vi.fn();
    const unsubscribeMarked = onUserDeletionMarked(marked);
    unsubscribes.push(onUserDeletionMarked(failing), onUserDeleted(deleted));
    await expect(notifyUserDeletionMarked("user-1")).resolves.toBeUndefined();
    expect(marked).toHaveBeenCalledWith("user-1");
    expect(failing).toHaveBeenCalledWith("user-1");
    expect(error).toHaveBeenCalledWith("[auth] user deletion marked listener failed", "TypeError");
    // Marks and deletes are separate channels.
    expect(deleted).not.toHaveBeenCalled();
    unsubscribeMarked();
    await notifyUserDeletionMarked("user-2");
    expect(marked).toHaveBeenCalledTimes(1);
  });

  it("registers session.create.before to refuse marked users", async () => {
    const guard = await import("./user-deletion-access-guard");
    const refuse = vi
      .spyOn(guard, "refuseSessionForDeletingUser")
      .mockRejectedValueOnce(Object.assign(new Error("pending"), { status: "FORBIDDEN" }));
    const before = auth.options.databaseHooks?.session?.create?.before;
    expect(before).toBeTypeOf("function");
    const sessionRow = {
      id: "session-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: "marked-user",
      expiresAt: new Date(Date.now() + 3_600_000),
      token: "token",
    };
    await expect(before?.(sessionRow)).rejects.toMatchObject({
      status: "FORBIDDEN",
    });
    expect(refuse).toHaveBeenCalledWith(sessionRow);
  });

  it("answers the session trigger's refusal with 403 through onAPIError, and passes other errors", () => {
    const onError = auth.options.onAPIError?.onError;
    expect(onError).toBeTypeOf("function");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The shape Prisma's pg adapter gives a trigger RAISE (see the PG test).
    const refusal = Object.assign(new Error("Invalid `prisma.session.create()` invocation"), {
      name: "DriverAdapterError",
      cause: { originalCode: "WMPD1", kind: "postgres", message: "user deletion pending" },
    });
    let thrown: unknown;
    try {
      onError?.(refusal);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toMatchObject({ status: "FORBIDDEN", body: { code: "USER_DELETION_PENDING" } });
    expect(() => onError?.(new TypeError("other"))).not.toThrow();
    expect(error).toHaveBeenCalled();
  });

  const removedUser = {
    id: "removed-user",
    email: "removed@example.com",
    emailVerified: true,
    name: "Removed",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("Better Auth's user.delete.before hook deletes durably, then notifies", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserDeleted(listener));
    deleteUserDurably.mockClear();
    deleteUserDurably.mockResolvedValueOnce("deleted");
    const before = auth.options.databaseHooks?.user?.delete?.before;
    expect(before).toBeTypeOf("function");
    // false tells Better Auth to skip its own (unordered, unbounded) DELETE.
    await expect(before?.(removedUser)).resolves.toBe(false);
    expect(deleteUserDurably).toHaveBeenCalledWith(
      expect.anything(),
      "removed-user",
      expect.any(Object),
    );
    expect(listener).toHaveBeenCalledWith("removed-user");
    expect(Object.keys(auth.options.databaseHooks?.user?.delete ?? {})).toEqual(["before"]);
  });

  it("does not notify when the delete found no user", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserDeleted(listener));
    deleteUserDurably.mockResolvedValueOnce("missing");
    const before = auth.options.databaseHooks?.user?.delete?.before;
    await expect(before?.(removedUser)).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports success without notifying while the durable delete is pending", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserDeleted(listener));
    deleteUserDurably.mockResolvedValueOnce("pending");
    const before = auth.options.databaseHooks?.user?.delete?.before;
    await expect(before?.(removedUser)).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("propagates a delete failure without notifying", async () => {
    const listener = vi.fn();
    unsubscribes.push(onUserDeleted(listener));
    deleteUserDurably.mockRejectedValueOnce(new Error("foreign key restrict"));
    const before = auth.options.databaseHooks?.user?.delete?.before;
    await expect(before?.(removedUser)).rejects.toThrow("foreign key restrict");
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses session and account deletes on a user-delete route when history is retained", async () => {
    const session = auth.options.databaseHooks?.session?.delete?.before;
    const account = auth.options.databaseHooks?.account?.delete?.before;
    const row = { ...removedUser, userId: "removed-user", token: "t", expiresAt: new Date() };
    findRetainedHistoryBlocker.mockResolvedValue("capacity lease");
    const route = { path: "/admin/remove-user" } as Parameters<NonNullable<typeof session>>[1];
    await expect(session?.(row, route)).rejects.toMatchObject({ status: "CONFLICT" });
    const accountRow = { ...row, providerId: "credential", accountId: "removed-user" };
    await expect(account?.(accountRow, route)).rejects.toMatchObject({ status: "CONFLICT" });
    // Sign-out and other session deletes are never gated.
    const signOut = { path: "/sign-out" } as Parameters<NonNullable<typeof session>>[1];
    await expect(session?.(row, signOut)).resolves.toBeUndefined();
    await expect(session?.(row, null)).resolves.toBeUndefined();
    findRetainedHistoryBlocker.mockResolvedValue(null);
    await expect(session?.(row, route)).resolves.toBeUndefined();
  });

  it("the user-delete preflight notifies marked listeners only when it starts the generation", async () => {
    const marked = vi.fn();
    unsubscribes.push(onUserDeletionMarked(marked));
    const session = auth.options.databaseHooks?.session?.delete?.before;
    const row = { ...removedUser, userId: "removed-user", token: "t", expiresAt: new Date() };
    const route = { path: "/admin/remove-user" } as Parameters<NonNullable<typeof session>>[1];
    findRetainedHistoryBlocker.mockResolvedValue(null);
    requestUserDeletion.mockResolvedValueOnce({ generation: "g", created: true });
    await session?.(row, route);
    expect(marked).toHaveBeenCalledTimes(1);
    requestUserDeletion.mockResolvedValueOnce({ generation: "g", created: false });
    await session?.(row, route);
    expect(marked).toHaveBeenCalledTimes(1);
  });
});
