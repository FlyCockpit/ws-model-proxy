import { createHash } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
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
vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(),
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
}));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => {
  const memory: Record<string, Row[]> = { user: [], account: [], session: [], verification: [] };
  const events: string[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => {
      if (typeof value === "object" && value !== null) {
        if ("startsWith" in value) return String(row[key]).startsWith(String(value.startsWith));
        if ("gt" in value && row[key] instanceof Date && value.gt instanceof Date)
          return row[key] > value.gt;
      }
      return row[key] === value;
    });
  const tx = {
    $queryRaw: vi.fn(async () => [{ acquired: true, locked: true }]),
    verification: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          memory.verification?.find((row) => matches(row, where)) ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const rows = memory.verification ?? [];
        memory.verification = rows.filter((row) => !matches(row, where));
        events.push("cleanup");
        return { count: rows.length - memory.verification.length };
      }),
    },
    user: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const rows = memory.user?.filter((row) => matches(row, where)) ?? [];
        for (const row of rows) Object.assign(row, data);
        events.push("verify and prove");
        return { count: rows.length };
      }),
    },
  };
  return {
    memory,
    events,
    tx,
    transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    revoke: vi.fn(),
  };
});
vi.mock("@ws-model-proxy/db", () => ({
  default: { ...db.tx, $transaction: db.transaction },
}));
vi.mock("./credential-revocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credential-revocation")>()),
  revokeUserCredentials: db.revoke,
}));

import { auth as productionAuth } from "./index";
import { handlePasswordAuthRequest } from "./password-auth-handler";
import { withPasswordWriteLock } from "./password-write-lock";
import { provedEmailKey } from "./proved-email";
import { registerShareInviteAcceptor } from "./share-invite-acceptance";

const userId = "invitee";
const email = "invitee@example.test";
const token = "mailed-invite";
const mailedIdentifier = `reset-password-mailed:${createHash("sha256").update(token).digest("base64url")}`;

async function setup() {
  const auth = betterAuth({
    ...productionAuth.options,
    database: memoryAdapter(db.memory),
    emailAndPassword: {
      ...productionAuth.options.emailAndPassword,
      enabled: true,
      password: {
        hash: async (password) => `hashed:${password}`,
        verify: async ({ hash, password }) => hash === `hashed:${password}`,
      },
    },
    logger: { disabled: true },
  });
  const context = await auth.$context;
  db.memory.user?.push({
    id: userId,
    email,
    name: "Invitee",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  db.memory.account?.push({
    id: "credential-account",
    userId,
    accountId: userId,
    providerId: "credential",
    password: "hashed:old-password",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const verifications: [string, string][] = [
    ["admin-invited:invitee", userId],
    [`reset-password:${token}`, userId],
    ["reset-password:other-link", userId],
    [mailedIdentifier, JSON.stringify({ userId, email })],
  ];
  for (const [identifier, value] of verifications) {
    await context.internalAdapter.createVerificationValue({
      identifier,
      value,
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  const accept = vi.fn(async () => {
    expect(db.memory.user?.[0]).toMatchObject({
      emailVerified: true,
      provedEmail: provedEmailKey(email),
    });
    expect(
      db.memory.verification?.some((row) => String(row.identifier).startsWith("reset-password:")),
    ).toBe(false);
    db.events.push("accept invites");
    return 1;
  });
  registerShareInviteAcceptor(accept);
  return { auth, accept };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.revoke.mockReset().mockResolvedValue(undefined);
  for (const table of Object.keys(db.memory)) db.memory[table] = [];
  db.events.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("production password reset finalization with SMTP", () => {
  it.each(["http", "server"] as const)(
    "%s verifies and proves the mailed invite, accepts shares and cleans links before reporting a post-sweep failure",
    async (transport) => {
      const { auth, accept } = await setup();
      const failure = new Error("post-sweep failed");
      db.revoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
      const body = { token, newPassword: "new-password" };
      const request = new Request("https://proxy.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://proxy.example.test" },
        body: JSON.stringify(body),
      });
      const outcome = await (transport === "http"
        ? handlePasswordAuthRequest(auth, request)
        : // Operational server calls must explicitly own the same lock scope too.
          withPasswordWriteLock(
            "/reset-password",
            request,
            async () => {
              await auth.api.resetPassword({ body });
              return new Response();
            },
            { getSession: async () => null },
          )
      ).then(
        (result) => {
          db.events.push("reported error");
          return result;
        },
        (error: unknown) => {
          db.events.push("reported error");
          return error;
        },
      );
      expect(db.revoke).toHaveBeenNthCalledWith(1, userId);
      expect(db.revoke).toHaveBeenNthCalledWith(2, userId);
      expect(db.memory.account?.[0]?.password).toBe("hashed:new-password");
      expect(
        db.memory.verification?.some((row) => row.identifier === `reset-password:${token}`),
      ).toBe(false);
      expect(db.memory.user?.[0]).toMatchObject({
        emailVerified: true,
        provedEmail: provedEmailKey(email),
      });
      expect(accept).toHaveBeenCalledExactlyOnceWith({ id: userId, email, emailVerified: true });
      expect(db.memory.verification?.map((row) => row.identifier)).toEqual([
        "admin-invited:invitee",
      ]);
      expect(db.events).toEqual([
        "cleanup",
        "cleanup",
        "verify and prove",
        "cleanup",
        "accept invites",
        "reported error",
      ]);
      if (transport === "http") {
        expect(outcome).toBeInstanceOf(Response);
        expect((outcome as Response).status).toBe(500);
      } else {
        expect(outcome).toBe(failure);
      }
    },
  );

  it("does not treat a reset that failed before committing as a spent mailed link", async () => {
    const { auth, accept } = await setup();
    const response = await auth.handler(
      new Request("https://proxy.example.test/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://proxy.example.test" },
        body: JSON.stringify({ token, newPassword: "short" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(db.revoke).toHaveBeenCalledExactlyOnceWith(userId);
    expect(db.memory.account?.[0]?.password).toBe("hashed:old-password");
    expect(db.memory.user?.[0]).toMatchObject({ emailVerified: false });
    expect(db.memory.user?.[0]?.provedEmail).toBeFalsy();
    expect(db.memory.verification?.map((row) => row.identifier)).toContain(mailedIdentifier);
    expect(accept).not.toHaveBeenCalled();
    expect(db.events).toEqual([]);
  });
});
