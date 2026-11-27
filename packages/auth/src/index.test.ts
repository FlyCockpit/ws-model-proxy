import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ config: undefined as unknown }));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://app.example.test",
    BETTER_AUTH_SECRET: "disposable-unit-test-secret-with-no-external-use",
  },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  renderResetPassword: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter: (_db: unknown, config: unknown) => {
    captured.config = config;
    return () => ({});
  },
}));
const { auth: production } = await import("./index");
const onPasswordReset = vi.fn(async () => {});
describe("password reset without adapter transactions", { timeout: 20_000 }, () => {
  it("creates the Prisma adapter with Better-Auth's default (no transactions)", () => {
    expect(captured.config).toEqual({ provider: "postgresql" });
  });

  it.each([400, 500])(
    "fails closed when the password write fails after the token was spent (%i)",
    async (status) => {
      const { APIError } = await import("better-auth/api");
      const { betterAuth: realBetterAuth } =
        await vi.importActual<typeof import("better-auth")>("better-auth");
      const { memoryAdapter } = await import("better-auth/adapters/memory");
      const now = new Date();
      const db: Record<string, Record<string, unknown>[]> = {
        user: [
          {
            id: "u1",
            email: "reset@example.test",
            name: "Reset",
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
        account: [],
        session: [
          {
            id: "s1",
            userId: "u1",
            token: "session-token",
            expiresAt: new Date(now.getTime() + 3_600_000),
            createdAt: now,
            updatedAt: now,
          },
        ],
        verification: [
          {
            id: "v1",
            identifier: "reset-password:the-token",
            value: "u1",
            expiresAt: new Date(now.getTime() + 3_600_000),
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      const memory = memoryAdapter(db);
      // Like chess's Prisma adapter: `transaction` just runs the work, so every
      // write commits as it happens. The account (password) write fails.
      const nonTransactional = ((adapterOptions: Parameters<typeof memory>[0]) => {
        const inner = memory(adapterOptions);
        const adapter: typeof inner = new Proxy(inner, {
          get(target, key, receiver) {
            if (key === "transaction")
              return (work: (trx: typeof inner) => unknown) => work(adapter);
            const value = Reflect.get(target, key, receiver);
            if ((key === "update" || key === "updateMany") && typeof value === "function") {
              return (args: { model: string }) => {
                if (args.model === "account") {
                  if (status === 400)
                    throw new APIError("BAD_REQUEST", { message: "password write failed" });
                  throw new Error("password write failed");
                }
                return Reflect.apply(value, target, [args]);
              };
            }
            return value;
          },
        });
        return adapter;
      }) as typeof memory;
      onPasswordReset.mockClear();
      const instance = realBetterAuth({
        baseURL: "https://app.example.test",
        secret: "disposable-unit-test-secret-with-no-external-use",
        database: nonTransactional,
        rateLimit: { enabled: false },
        emailAndPassword: {
          enabled: true,
          revokeSessionsOnPasswordReset: true,
          onPasswordReset: onPasswordReset,
        },
        logger: { disabled: true },
      } as Parameters<typeof realBetterAuth>[0]);
      const ctx = await instance.$context;
      const oldHash = await ctx.password.hash("old-password-12345");
      db.account?.push({
        id: "a1",
        userId: "u1",
        accountId: "u1",
        providerId: "credential",
        password: oldHash,
        createdAt: now,
        updatedAt: now,
      });

      const res = await instance.handler(
        new Request("https://app.example.test/api/auth/reset-password", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://app.example.test" },
          body: JSON.stringify({ token: "the-token", newPassword: "new-password-12345" }),
        }),
      );

      expect(res.status).toBe(status);
      expect(db.verification).toHaveLength(0); // the link is spent
      expect(db.session).toHaveLength(0); // existing sessions were deleted
      expect(db.account?.[0]?.password).toBe(oldHash); // the old password stays
      expect(onPasswordReset).not.toHaveBeenCalled();
    },
  );
});

it("wires fail-closed password create/update hooks in the production configuration", async () => {
  const hooks = production.options.databaseHooks?.account;
  await expect(hooks?.create?.before?.({ password: "hash" } as never, null)).rejects.toThrow(
    /password-write lock/,
  );
  await expect(hooks?.update?.before?.({ password: "hash" }, null)).rejects.toThrow(
    /password-write lock/,
  );
  expect(production.options.databaseHooks?.session?.create?.after).toBeTypeOf("function");
  expect(production.options.databaseHooks?.verification?.create?.after).toBeTypeOf("function");
});

describe("production after-hook wiring", () => {
  it.each(["create", "update"] as const)(
    "account %s awaits password-write confirmation",
    async (kind) => {
      const lock = await import("./password-write-lock");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const marker = new Error("confirmation refused");
      const confirm = vi.spyOn(lock, "confirmPasswordWriteLocked").mockImplementation(async () => {
        await gate;
        throw marker;
      });
      const hook = production.options.databaseHooks?.account?.[kind]?.after;
      let settled = false;
      const result = Promise.resolve(
        hook?.({ userId: "u1", providerId: "credential", password: "hash" } as never, null),
      ).finally(() => {
        settled = true;
      });
      const refused = expect(result).rejects.toBe(marker);
      try {
        await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
        expect(confirm).toHaveBeenCalledWith({
          hash: production.options.emailAndPassword?.password?.hash,
        });
        expect(settled).toBe(false);
      } finally {
        release();
        await refused;
        confirm.mockRestore();
      }
    },
  );
  it("session creation awaits the final credential fence", async () => {
    const fence = await import("./password-sign-in-fence");
    const marker = new Error("session fence refused");
    const check = vi.spyOn(fence, "fencePasswordSessionAfter").mockRejectedValueOnce(marker);
    try {
      const session = { id: "s", userId: "u" };
      await expect(
        production.options.databaseHooks?.session?.create?.after?.(session as never, null),
      ).rejects.toBe(marker);
      expect(check).toHaveBeenCalledExactlyOnceWith(session, null);
    } finally {
      check.mockRestore();
    }
  });
  it("challenge creation awaits recording its credential proof", async () => {
    const fence = await import("./password-sign-in-fence");
    const marker = new Error("challenge proof refused");
    const record = vi.spyOn(fence, "recordTwoFactorChallenge").mockRejectedValueOnce(marker);
    try {
      const row = { identifier: "2fa-test", value: "u", expiresAt: new Date() };
      await expect(
        production.options.databaseHooks?.verification?.create?.after?.(row as never),
      ).rejects.toBe(marker);
      expect(record).toHaveBeenCalledExactlyOnceWith(row);
    } finally {
      record.mockRestore();
    }
  });
});

it("production account creation records the initial signup credential before inserting", async () => {
  const fence = await import("./password-sign-in-fence");
  const record = vi.spyOn(fence, "recordSignUpCredential");
  const account = { userId: "new-user", providerId: "credential", password: "hash" };
  const context = { path: "/sign-up/email", context: {} };
  try {
    await production.options.databaseHooks?.account?.create?.before?.(
      account as never,
      context as never,
    );
    expect(record).toHaveBeenCalledExactlyOnceWith(account, context);
  } finally {
    record.mockRestore();
  }
});
