import { getAuthTables } from "better-auth";
import { describe, expect, it, vi } from "vitest";

/**
 * The user-deletion columns (`deletionRequestedAt`, `deletionGeneration`,
 * `deletionSweep*`) are written only by @ws-model-proxy/db/parent-deletion.
 * Better Auth cannot write them because they are not in its user schema: its
 * adapter factory's `transformInput` keeps only schema fields, so
 * `internalAdapter.updateUser` (which `/admin/update-user` feeds with
 * `ctx.body.data` unfiltered) drops them before the Prisma call. Declaring any
 * of them as a Better Auth `additionalFields` entry would make them writable
 * through that route (clearing the marker, or leaving a marker without a
 * generation). These tests pin both halves on the real auth instance.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "deletion-columns-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
}));

// Recording Prisma stand-in: every delegate records update/updateMany calls
// and answers reads with one user row.
const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; method: string; data: Record<string, unknown> }>,
}));
vi.mock("@ws-model-proxy/db", () => {
  const row = {
    id: "u1",
    email: "u1@example.test",
    name: "U1",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    banned: true,
  };
  const delegate = (model: string) => ({
    update: async (args: { data: Record<string, unknown> }) => {
      calls.push({ model, method: "update", data: args.data });
      return { ...row, ...args.data };
    },
    updateMany: async (args: { data: Record<string, unknown> }) => {
      calls.push({ model, method: "updateMany", data: args.data });
      return { count: 1 };
    },
    findFirst: async () => row,
    findUnique: async () => row,
    findMany: async () => [row],
    count: async () => 1,
  });
  const client: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === "$transaction") return (work: (tx: unknown) => unknown) => work(client);
        return delegate(String(property));
      },
    },
  );
  return { default: client };
});

vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

const { auth } = await import("./index");

const DELETION_COLUMNS = [
  "deletionRequestedAt",
  "deletionGeneration",
  "deletionSweepAttempts",
  "deletionSweepLastAttemptAt",
  "deletionSweepNextAttemptAt",
];

describe("user-deletion columns are not Better Auth fields", () => {
  it("are neither additionalFields nor fields of Better Auth's user table", () => {
    const additional = Object.keys(auth.options.user?.additionalFields ?? {});
    const userFields = Object.keys(getAuthTables(auth.options).user?.fields ?? {});
    for (const column of DELETION_COLUMNS) {
      expect(additional, column).not.toContain(column);
      expect(userFields, column).not.toContain(column);
    }
  });

  it("internalAdapter.updateUser (the /admin/update-user write) drops them", async () => {
    const context = await auth.$context;
    calls.length = 0;
    await context.internalAdapter.updateUser("u1", {
      deletionRequestedAt: null,
      deletionGeneration: null,
      deletionSweepAttempts: 0,
      deletionSweepLastAttemptAt: null,
      deletionSweepNextAttemptAt: null,
      banned: false,
    });
    const writes = calls.filter((call) => call.model === "user");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      for (const column of DELETION_COLUMNS) expect(Object.keys(write.data)).not.toContain(column);
    }
    // The Better Auth field in the same call still goes through.
    expect(writes.some((write) => write.data.banned === false)).toBe(true);
  });
});
