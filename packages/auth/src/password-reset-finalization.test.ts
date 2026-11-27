import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: false,
    BETTER_AUTH_URL: "https://proxy.example.test",
    BETTER_AUTH_SECRET: "reset-finalization-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: "smtp.example.test",
  },
  SIGNUP_ENABLED: false,
}));
const mail = vi.hoisted(() => ({ configured: true }));
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => mail.configured,
  sendEmail: vi.fn(),
  renderVerifyEmail: () => ({ subject: "Verify", html: "" }),
  renderResetPassword: () => ({ subject: "Reset", html: "" }),
  renderTwoFactorOtp: vi.fn(),
}));

type Row = Record<string, unknown>;
// Real pinned Prisma adapter and production hooks. This fixture replaces only SQL:
// private staged writes, READ COMMITTED reads, transaction locks and rollback.
const db = vi.hoisted(() => {
  type State = { id: number; staged?: Record<string, Row[]>; xid: boolean; locks: Set<string> };
  const tables: Record<string, Row[]> = {};
  const events: string[] = [];
  const holders = new Map<string, State>();
  const waiters = new Map<string, (() => void)[]>();
  let serial = 0;
  let connections = 0;
  let peak = 0;
  let lockLimit = 2;
  let onAttempt: ((key: string, blocked: boolean) => void) | undefined;
  let failCommit = false;
  let onFailure: (() => void) | undefined;
  let onLock: ((key: string) => Promise<void>) | undefined;
  let onRead: ((where: Row) => void) | undefined;
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "AND") return (value as Row[]).every((part) => matches(row, part));
      if (key === "OR") return (value as Row[]).some((part) => matches(row, part));
      const have = row[key];
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const filter = value as Row;
        if ("equals" in filter && have !== filter.equals) return false;
        if ("startsWith" in filter && !String(have).startsWith(String(filter.startsWith)))
          return false;
        if ("not" in filter && have === filter.not) return false;
        if ("in" in filter && !(filter.in as unknown[]).includes(have)) return false;
        if (
          "lt" in filter &&
          !(have instanceof Date && filter.lt instanceof Date && have < filter.lt)
        )
          return false;
        if (
          "gt" in filter &&
          !(have instanceof Date && filter.gt instanceof Date && have > filter.gt)
        )
          return false;
        return true;
      }
      return have === value;
    });
  const acquire = async (state: State, key: string, wait: boolean) => {
    await onLock?.(key);
    onAttempt?.(key, holders.has(key) && holders.get(key) !== state);
    while (holders.has(key) && holders.get(key) !== state) {
      if (!wait) return false;
      await new Promise<void>((resolve) => {
        const queue = waiters.get(key) ?? [];
        queue.push(resolve);
        waiters.set(key, queue);
      });
    }
    holders.set(key, state);
    state.locks.add(key);
    events.push(`${state.id}:lock:${key}`);
    return true;
  };
  const make = (state?: State) => {
    const read = () => state?.staged ?? tables;
    const write = (name: string) => {
      if (name === "user" && state && !state.locks.has("00:owner:invitee"))
        throw new Error("missing owner before user write");
      if (state) {
        state.xid = true;
        state.staged ??= structuredClone(tables);
      }
      events.push(`${state?.id ?? "root"}:write:${name}`);
      return read();
    };
    const delegate = (name: string) => {
      const findMany = async ({
        where = {},
        take,
        select,
      }: {
        where?: Row;
        take?: number;
        select?: Row;
      } = {}) => {
        onRead?.(where);
        return (read()[name] ?? [])
          .filter((row) => matches(row, where))
          .slice(0, take)
          .map((row) => {
            const result = { ...row };
            if (name === "user" && select?.accounts) {
              result.accounts = (read().account ?? [])
                .filter((account) => account.userId === row.id)
                .slice(0, 2);
              result.sessions = (read().session ?? [])
                .filter(
                  (session) =>
                    session.userId === row.id &&
                    session.expiresAt instanceof Date &&
                    session.expiresAt > new Date(),
                )
                .slice(0, 1);
            }
            return result;
          });
      };
      return {
        findMany,
        findFirst: async (args: Parameters<typeof findMany>[0]) =>
          (await findMany(args))[0] ?? null,
        findUnique: async (args: Parameters<typeof findMany>[0]) =>
          (await findMany(args))[0] ?? null,
        create: async ({ data }: { data: Row }) => {
          const store = write(name);
          const row = { id: `row-${++serial}`, ...data };
          store[name] ??= [];
          store[name].push(row);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          const store = write(name);
          const rows = (store[name] ?? []).filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
          const row = (write(name)[name] ?? []).find((row) => matches(row, where));
          if (!row) throw Object.assign(new Error("missing row"), { code: "P2025" });
          Object.assign(row, data);
          return { ...row };
        },
        deleteMany: async ({ where }: { where: Row }) => {
          const store = write(name);
          const rows = store[name] ?? [];
          store[name] = rows.filter((row) => !matches(row, where));
          return { count: rows.length - store[name].length };
        },
        delete: async ({ where }: { where: Row }) => {
          const store = write(name);
          const row = (store[name] ?? []).find((row) => matches(row, where));
          if (!row) throw Object.assign(new Error("missing row"), { code: "P2025" });
          store[name] = store[name]!.filter((item) => item !== row);
          return { ...row };
        },
      };
    };
    return {
      user: delegate("user"),
      account: delegate("account"),
      session: delegate("session"),
      verification: delegate("verification"),
      apiKey: delegate("apiKey"),
      agentToken: delegate("agentToken"),
      mcpGrant: delegate("mcpGrant"),
      nodeCredential: delegate("nodeCredential"),
      nodeEnrollmentCode: delegate("nodeEnrollmentCode"),
      oauthRefreshToken: delegate("oauthRefreshToken"),
      oauthAccessToken: delegate("oauthAccessToken"),
      oauthConsent: delegate("oauthConsent"),
      $executeRaw: async (_sql: TemplateStringsArray, key?: string) => {
        if (key?.startsWith("password-write:") && state) await acquire(state, key, true);
        return 1;
      },
      $queryRaw: async (sql: TemplateStringsArray, value: unknown, wait?: boolean) => {
        if (!state) throw new Error("SQL requires a transaction");
        const query = sql.join("?");
        if (query.includes("wsmp_acquire_fences")) {
          if (state.xid) throw new Error("WMPF1: fence acquired after xid");
          for (const key of value as string[]) await acquire(state, key, wait !== false);
          return [{ acquired: true }];
        }
        if (query.includes("current_setting")) return [{ held: `,${[...state.locks].join(",")},` }];
        if (query.includes("pg_try_advisory_xact_lock"))
          return [{ locked: await acquire(state, String(value), false) }];
        throw new Error(`unexpected SQL ${query}`);
      },
    };
  };
  const rawTransaction = async (work: (tx: ReturnType<typeof make>) => Promise<unknown>) => {
    const state: State = { id: ++serial, xid: false, locks: new Set() };
    connections++;
    peak = Math.max(peak, connections);
    if (connections > lockLimit) throw new Error("exhausted lock connections");
    try {
      const result = await work(make(state));
      if (state.staged) {
        if (failCommit && state.staged.account?.[0]?.password !== tables.account?.[0]?.password) {
          failCommit = false;
          onFailure?.();
          throw new Error("fixture commit failure");
        }
        for (const key of Object.keys(tables)) delete tables[key];
        Object.assign(tables, state.staged);
        events.push(`${state.id}:commit`);
      }
      return result;
    } catch (error) {
      events.push(`${state.id}:rollback`);
      throw error;
    } finally {
      connections--;
      for (const key of state.locks) {
        holders.delete(key);
        for (const resolve of waiters.get(key) ?? []) resolve();
        waiters.delete(key);
      }
    }
  };
  return {
    tables,
    events,
    client: { ...make(), $transaction: vi.fn() },
    rawTransaction,
    connections: () => connections,
    peak: () => peak,
    lockLimit: () => lockLimit,
    setPool: (pool: number) => {
      lockLimit = pool - 1;
    },
    setAttempt: (callback?: typeof onAttempt) => {
      onAttempt = callback;
    },
    failCommit: (callback?: () => void) => {
      failCommit = true;
      onFailure = callback;
    },
    setLock: (callback?: typeof onLock) => {
      onLock = callback;
    },
    setRead: (callback?: typeof onRead) => {
      onRead = callback;
    },
    reset: () => {
      peak = 0;
      lockLimit = 2;
      onAttempt = undefined;
      failCommit = false;
      onFailure = undefined;
      onLock = undefined;
      onRead = undefined;
    },
  };
});
vi.mock("@ws-model-proxy/db", () => ({ default: db.client }));
vi.mock("./credential-revocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credential-revocation")>();
  return { ...actual, revokeUserCredentials: vi.fn(actual.revokeUserCredentials) };
});

import { revokeUserCredentials } from "./credential-revocation";
import { auth as productionAuth } from "./index";
import {
  configureLockSlots,
  releaseSlots,
  tryAcquireSlots,
  withTransactionSlot,
} from "./lock-slots";
import { handlePasswordAuthRequest } from "./password-auth-handler";
import { withPasswordWriteLock } from "./password-write-lock";
import { provedEmailKey } from "./proved-email";
import { registerShareInviteAcceptor } from "./share-invite-acceptance";

const userId = "invitee";
const email = "invitee@example.test";
const token = "mailed-invite";
const mailedIdentifier = (value: string) =>
  `reset-password-mailed:${createHash("sha256").update(value).digest("base64url")}`;
const user = () => db.tables.user![0]!;
const credential = () => db.tables.account![0]!;
const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function setup({ smtp = true, mailed = true, omitVerification = false } = {}) {
  mail.configured = smtp;
  // Preserve production adapter/hooks while selecting the explicit private-mode option.
  const options = productionAuth.options;
  const auth = betterAuth({
    ...options,
    emailAndPassword: {
      ...options.emailAndPassword,
      enabled: true,
      requireEmailVerification: omitVerification ? undefined : smtp,
      password: {
        hash: async (password) => `hashed:${password}`,
        verify: async ({ hash, password }) => hash === `hashed:${password}`,
      },
    },
    logger: { disabled: true },
  });
  const context = await auth.$context;
  const now = new Date();
  db.tables.user = [
    {
      id: userId,
      email,
      name: "Invitee",
      emailVerified: false,
      provedEmail: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
  db.tables.account = [
    {
      id: "credential-account",
      userId,
      accountId: userId,
      providerId: "credential",
      password: "hashed:old-password",
      createdAt: now,
      updatedAt: now,
    },
  ];
  db.tables.session = [];
  db.tables.verification = [];
  const link = async (value: string, isMailed: boolean) => {
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${value}`,
      value: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (isMailed)
      await context.internalAdapter.createVerificationValue({
        identifier: mailedIdentifier(value),
        value: JSON.stringify({ userId, email }),
        expiresAt: new Date(Date.now() + 60_000),
      });
  };
  await context.internalAdapter.createVerificationValue({
    identifier: "admin-invited:invitee",
    value: userId,
    expiresAt: new Date("9999-12-31"),
  });
  await link(token, mailed);
  await link("other-link", false);
  const accept = vi.fn(async (accepted: { id: string; email: string; emailVerified: boolean }) => {
    if (accepted.emailVerified) {
      expect(db.connections()).toBeLessThanOrEqual(1);
      expect(user()).toMatchObject({ emailVerified: true, provedEmail: provedEmailKey(email) });
      expect(
        db.tables.verification?.some((row) => String(row.identifier).startsWith("reset-password:")),
      ).toBe(false);
      db.events.push("accept invites");
    }
    return 1;
  });
  registerShareInviteAcceptor(accept);
  const request = (value = token, newPassword = "new-password") =>
    new Request("https://proxy.example.test/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://proxy.example.test" },
      body: JSON.stringify({ token: value, newPassword }),
    });
  const reset = (value = token, newPassword = "new-password") =>
    handlePasswordAuthRequest(auth, request(value, newPassword));
  const verify = async () => {
    const verification = await createEmailVerificationToken(context.secret, email);
    return auth.handler(
      new Request(`https://proxy.example.test/api/auth/verify-email?token=${verification}`),
    );
  };
  return { auth, context, accept, reset, verify, link, request };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  for (const key of Object.keys(db.tables)) delete db.tables[key];
  db.events.length = 0;
  configureLockSlots(3);
  db.client.$transaction.mockImplementation((work) =>
    withTransactionSlot(() => db.rawTransaction(work)),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(db.connections()).toBe(0);
  expect(tryAcquireSlots(db.lockLimit())).toBe(true);
  releaseSlots(db.lockLimit());
});

describe("production selective reset finalization", () => {
  it.each(["http", "server"] as const)(
    "%s processes committed proof before surfacing a callback error",
    async (transport) => {
      const { auth, accept, request, reset } = await setup();
      const failure = new Error("post-sweep failed");
      // Pre-sweep succeeds; only the committed callback's second sweep fails.
      vi.mocked(revokeUserCredentials).mockReset();
      const actual =
        await vi.importActual<typeof import("./credential-revocation")>("./credential-revocation");
      vi.mocked(revokeUserCredentials)
        .mockImplementation(actual.revokeUserCredentials)
        .mockImplementationOnce(actual.revokeUserCredentials)
        .mockRejectedValueOnce(failure);
      const outcome = await (transport === "http"
        ? reset()
        : withPasswordWriteLock(
            "/reset-password",
            request(),
            async () => {
              await auth.api.resetPassword({ body: { token, newPassword: "new-password" } });
              return new Response();
            },
            { getSession: async () => null },
          )
      ).catch((error: unknown) => error);
      expect(revokeUserCredentials).toHaveBeenNthCalledWith(1, userId);
      expect(revokeUserCredentials).toHaveBeenNthCalledWith(2, userId);
      expect(credential().password).toBe("hashed:new-password");
      expect(user()).toMatchObject({ emailVerified: true, provedEmail: provedEmailKey(email) });
      expect(accept).toHaveBeenCalledExactlyOnceWith({ id: userId, email, emailVerified: true });
      expect(db.tables.verification?.map((row) => row.identifier)).toEqual([
        "admin-invited:invitee",
      ]);
      if (transport === "http") expect((outcome as Response).status).toBe(500);
      else expect(outcome).toBe(failure);
    },
  );

  it("accepts shares after a successful callback using committed current proof", async () => {
    const { reset, accept } = await setup();
    expect((await reset()).status).toBe(200);
    expect(accept).toHaveBeenCalledExactlyOnceWith({ id: userId, email, emailVerified: true });
    expect(db.peak()).toBe(2);
  });

  it.each([false, true])(
    "rolls back password, proof, token and siblings, suppresses after-hooks even with lapsed lock=%s, then retries",
    async (lapsed) => {
      const { reset, accept, context } = await setup();
      const confirm = vi.spyOn(context.options.databaseHooks!.account!.update!, "after");
      const now = performance.now.bind(performance);
      let restoreClock: (() => void) | undefined;
      db.failCommit(
        lapsed
          ? () => {
              const clock = vi.spyOn(performance, "now").mockReturnValue(now() + 30_000);
              restoreClock = () => clock.mockRestore();
            }
          : undefined,
      );
      try {
        expect((await reset()).status).toBe(500);
      } finally {
        restoreClock?.();
      }
      expect(credential().password).toBe("hashed:old-password");
      expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
      expect(db.tables.verification?.map((row) => row.identifier)).toEqual(
        expect.arrayContaining([
          `reset-password:${token}`,
          "reset-password:other-link",
          mailedIdentifier(token),
        ]),
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expect(revokeUserCredentials).toHaveBeenCalledTimes(1);
      expect((await reset()).status).toBe(200);
      expect(credential().password).toBe("hashed:new-password");
      expect(user()).toMatchObject({ emailVerified: true, provedEmail: provedEmailKey(email) });
      expect(accept).toHaveBeenCalledOnce();
    },
  );

  it("releases the spend slot before queued account after-hooks acquire another transaction at pool 3", async () => {
    const { reset, context } = await setup();
    const hooks = context.options.databaseHooks!.account!.update!;
    const after = hooks.after!;
    vi.spyOn(hooks, "after").mockImplementation(async (...args) => {
      expect(db.connections()).toBe(1); // Only the outer password-write transaction remains.
      expect(credential().password).toBe("hashed:new-password");
      await db.client.$transaction(async () => {
        expect(db.connections()).toBe(2);
      });
      await after(...args);
    });
    expect((await reset()).status).toBe(200);
    expect(hooks.after).toHaveBeenCalledOnce();
    expect(db.peak()).toBe(2);
  });

  it("bound verification requires the existing owner fence and never reacquires it after reset writes", async () => {
    const { context, request } = await setup();
    await withPasswordWriteLock(
      "/reset-password",
      request(),
      async () => {
        await expect(
          context.adapter.transaction((bound) =>
            bound.update({
              model: "user",
              where: [{ field: "id", value: userId }],
              update: { emailVerified: true },
            }),
          ),
        ).rejects.toThrow("owner fences");
        await context.adapter.transaction(async (bound) => {
          const row = db.tables.verification!.find(
            (row) => row.identifier === `reset-password:${token}`,
          )!;
          await bound.consumeOne({
            model: "verification",
            where: [{ field: "id", value: String(row.id) }],
          });
          expect(
            await bound.findMany({
              model: "verification",
              where: [{ field: "identifier", value: "reset-password:other-link" }],
            }),
          ).toEqual([]);
          expect(
            await bound.findOne({ model: "user", where: [{ field: "id", value: userId }] }),
          ).toMatchObject({ emailVerified: true });
          expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
          await bound.update({
            model: "user",
            where: [{ field: "id", value: userId }],
            update: { emailVerified: true },
          });
        });
        return new Response();
      },
      { getSession: async () => null },
    );
    expect(user()).toMatchObject({ emailVerified: true, provedEmail: provedEmailKey(email) });
    const writes = db.events.filter((event) => event.includes(":write:user"));
    expect(writes).toHaveLength(2);
    const spendingTx = writes[0]!.split(":")[0];
    expect(
      db.events.filter((event) => event === `${spendingTx}:lock:00:owner:invitee`),
    ).toHaveLength(1);
  });

  it("consumeOne refuses a token whose owner differs from the held password lock", async () => {
    const { context, request } = await setup();
    const row = db.tables.verification!.find(
      (row) => row.identifier === `reset-password:${token}`,
    )!;
    await withPasswordWriteLock(
      "/reset-password",
      request(),
      async () => {
        row.value = "another-user";
        await expect(
          context.adapter.transaction((bound) =>
            bound.consumeOne({
              model: "verification",
              where: [{ field: "id", value: String(row.id) }],
            }),
          ),
        ).rejects.toThrow("password-write lock");
        return new Response();
      },
      { getSession: async () => null },
    );
    expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
    expect(credential().password).toBe("hashed:old-password");
  });

  it("unspecified verification policy never implicitly activates a private invite", async () => {
    const { reset, accept } = await setup({ smtp: false, mailed: false, omitVerification: true });
    expect((await reset()).status).toBe(200);
    expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
    expect(accept).not.toHaveBeenCalled();
  });

  it("private no-SMTP invite becomes usable without mailbox proof or share acceptance", async () => {
    const { reset, accept, context } = await setup({ smtp: false, mailed: false });
    expect((await reset()).status).toBe(200);
    expect(user()).toMatchObject({ emailVerified: true, provedEmail: null });
    expect(
      await context.password.verify({
        hash: String(credential().password),
        password: "new-password",
      }),
    ).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses before commit without consuming mailed proof", async () => {
    const { reset, accept } = await setup();
    expect((await reset(token, "short")).status).toBe(400);
    expect(credential().password).toBe("hashed:old-password");
    expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
    expect(accept).not.toHaveBeenCalled();
    expect(db.tables.verification?.map((row) => row.identifier)).toContain(mailedIdentifier(token));
  });

  it.each(["verified", "provider", "session", "unmarked"] as const)(
    "consume-time admission rejects a still-live shown token after its earlier check: %s",
    async (change) => {
      const { reset, context, accept } = await setup({ mailed: false });
      const entered = latch();
      const release = latch();
      vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
        entered.resolve();
        await release.promise;
        return `hashed:${password}`;
      });
      const pending = reset();
      await entered.promise; // Read-only before-hook already admitted the shown token.
      if (change === "verified") user().emailVerified = true;
      if (change === "provider")
        db.tables.account!.push({ id: "external", userId, providerId: "other" });
      if (change === "session")
        db.tables.session!.push({ id: "live", userId, expiresAt: new Date(Date.now() + 60_000) });
      if (change === "unmarked")
        db.tables.verification = db.tables.verification!.filter(
          (row) => row.identifier !== "admin-invited:invitee",
        );
      release.resolve();
      expect((await pending).status).toBe(400);
      expect(credential().password).toBe("hashed:old-password");
      expect(user().provedEmail).toBeNull();
      expect(accept).not.toHaveBeenCalled();
      expect(revokeUserCredentials).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["malformed", "user", "email", "expired"] as const)(
    "never treats an invalid %s mail marker as mailbox proof",
    async (kind) => {
      const { reset, accept, context } = await setup();
      db.tables.verification = db.tables.verification!.filter(
        (row) => row.identifier !== "admin-invited:invitee",
      );
      const mark = db.tables.verification!.find(
        (row) => row.identifier === mailedIdentifier(token),
      )!;
      if (kind === "malformed") mark.value = "invalid-json";
      if (kind === "user") mark.value = JSON.stringify({ userId: "other-user", email });
      if (kind === "email") mark.value = JSON.stringify({ userId, email: "other@example.test" });
      if (kind === "expired")
        vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
          db.tables.verification!.find(
            (row) => row.identifier === mailedIdentifier(token),
          )!.expiresAt = new Date(Date.now() - 1_000);
          return `hashed:${password}`;
        });
      expect((await reset()).status).toBe(400);
      expect(user()).toMatchObject({ emailVerified: false, provedEmail: null });
      expect(credential().password).toBe("hashed:old-password");
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it.each(["shown", "mailed"] as const)(
    "serializes %s reset first at the actual handler hash",
    async (first) => {
      configureLockSlots(5);
      db.setPool(5);
      const { reset, context, link, accept } = await setup();
      await link("shown", false);
      const entered = latch();
      const release = latch();
      const attempted = latch();
      let blocked = false;
      vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
        entered.resolve();
        await release.promise;
        return `hashed:${password}`;
      });
      const winner = reset(first === "mailed" ? token : "shown", `${first}-password`);
      await entered.promise;
      db.setAttempt((key, waits) => {
        if (key.startsWith("password-write:")) {
          blocked = waits;
          attempted.resolve();
        }
      });
      const other = first === "mailed" ? "shown" : token;
      const loser = reset(other, "loser-password");
      try {
        await attempted.promise;
      } finally {
        db.setAttempt();
        release.resolve();
      }
      const [won, lost] = await Promise.all([winner, loser]);
      expect(blocked).toBe(true); // Actual PW conflict, with spare pool/slot capacity.
      expect(won.status).toBe(200);
      expect(lost.status).toBe(400);
      expect(credential().password).toBe(`hashed:${first}-password`);
      expect(user()).toMatchObject({
        emailVerified: first === "mailed",
        provedEmail: first === "mailed" ? provedEmailKey(email) : null,
      });
      expect(accept).toHaveBeenCalledTimes(first === "mailed" ? 1 : 0);
    },
  );

  it.each(["shown", "verify"] as const)(
    "serializes %s before the competing verification/reset write",
    async (first) => {
      configureLockSlots(5);
      db.setPool(5);
      const { reset, verify, context } = await setup({ mailed: false });
      const entered = latch();
      const release = latch();
      const attempted = latch();
      let blocked = false;
      if (first === "shown")
        vi.spyOn(context.password, "hash").mockImplementationOnce(async (password) => {
          entered.resolve();
          await release.promise;
          return `hashed:${password}`;
        });
      else
        db.setLock(async (key) => {
          if (key === "00:owner:invitee") {
            entered.resolve();
            await release.promise;
          }
        });
      const winner = first === "shown" ? reset() : verify();
      await entered.promise;
      db.setAttempt((key, waits) => {
        if (key.startsWith("password-write:")) {
          blocked = waits;
          attempted.resolve();
        }
      });
      const loser = first === "shown" ? verify() : reset();
      try {
        await attempted.promise;
      } finally {
        db.setAttempt();
        db.setLock();
        release.resolve();
      }
      const [won, lost] = await Promise.all([winner, loser]);
      expect(blocked).toBe(true);
      expect(won.status).toBe(200);
      expect(lost.status).toBe(first === "shown" ? 200 : 400);
      expect(user()).toMatchObject({ emailVerified: true, provedEmail: provedEmailKey(email) });
      expect(credential().password).toBe(
        first === "shown" ? "hashed:new-password" : "hashed:old-password",
      );
    },
  );

  it.each(["email", "email-case", "id", "unverified", "unproved", "wrong-proof"] as const)(
    "never accepts shares for committed callback/current %s mismatch",
    async (mismatch) => {
      const { reset, accept } = await setup();
      const actual =
        await vi.importActual<typeof import("./credential-revocation")>("./credential-revocation");
      vi.mocked(revokeUserCredentials)
        .mockImplementationOnce(actual.revokeUserCredentials)
        .mockImplementationOnce(async () => {
          if (mismatch === "email") user().email = "changed@example.test";
          if (mismatch === "email-case") user().email = "Invitee@example.test";
          if (mismatch === "id") user().id = "different-user";
          if (mismatch === "unverified") user().emailVerified = false;
          if (mismatch === "unproved") user().provedEmail = null;
          if (mismatch === "wrong-proof") user().provedEmail = "different@example.test";
          throw new Error("callback failed after commit");
        });
      expect((await reset()).status).toBe(500);
      expect(credential().password).toBe("hashed:new-password");
      expect(accept).not.toHaveBeenCalled();
    },
  );
});
