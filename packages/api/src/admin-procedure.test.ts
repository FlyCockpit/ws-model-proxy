import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { invalidateForceTwoFactorPolicyCache } from "@ws-model-proxy/auth/force-two-factor-policy";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// `adminProcedure` imports from @ws-model-proxy/env/server, which validates
// `process.env` at import time. Mock the module so this test doesn't need a
// real .env at resolve time.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
}));

import type { Context } from "./context";
import { adminOr404Procedure, adminProcedure, protectedProcedure } from "./index";

const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  appSetting: {
    findUnique: MockInstance;
  };
};

/**
 * Minimal router that uses adminProcedure so we can exercise the middleware
 * chain (requireAuth → requireAdmin) in isolation.
 */
const testRouter = {
  ping: adminProcedure.handler(async () => {
    return { ok: true };
  }),
};

const protectedRouter = {
  ping: protectedProcedure.handler(async () => {
    return { ok: true };
  }),
};

const testRouter404 = {
  ping: adminOr404Procedure.handler(async () => {
    return { ok: true };
  }),
};

/** Build a minimal oRPC context for testing. */
function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };

  return {
    session: {
      user: {
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "test-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateForceTwoFactorPolicyCache();
  db.appSetting.findUnique.mockResolvedValue(null);
});

describe("protectedProcedure", () => {
  it("throws FORBIDDEN when force2fa is enabled and the user has no second factor", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const ctx = buildContext({ user: { twoFactorEnabled: false } });
    const client = createRouterClient(protectedRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  it("passes through when force2fa is enabled and the user has a second factor", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const ctx = buildContext({ user: { twoFactorEnabled: true } });
    const client = createRouterClient(protectedRouter, { context: ctx });

    await expect(client.ping()).resolves.toEqual({ ok: true });
  });
});

describe("adminProcedure", () => {
  it("throws FORBIDDEN with 'Email verification required' when emailVerified is false", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Email verification required for admin access.");
      return true;
    });
  });

  it("throws FORBIDDEN with 'Admin access required' when role is not admin", async () => {
    const ctx = buildContext({ user: { role: "user", emailVerified: true } });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toBe("Admin access required.");
      return true;
    });
  });

  it("passes through to the handler for a verified admin", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
    const client = createRouterClient(testRouter, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });

  it("throws FORBIDDEN when force2fa is enabled and the admin has no second factor", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.message).toMatch(/Two-factor authentication setup is required/);
      return true;
    });
  });

  it("passes through to the handler when admin appears in a comma-separated role list", async () => {
    const ctx = buildContext({ user: { role: "editor, admin, billing", emailVerified: true } });
    const client = createRouterClient(testRouter, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });
});

describe("adminOr404Procedure", () => {
  it("throws NOT_FOUND when no session is provided", async () => {
    const ctx = buildContext(null);
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("throws NOT_FOUND when emailVerified is false", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("throws NOT_FOUND when role is not admin", async () => {
    const ctx = buildContext({ user: { role: "user", emailVerified: true } });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("passes through to the handler for a verified admin", async () => {
    const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
    const client = createRouterClient(testRouter404, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });

  it("throws NOT_FOUND when force2fa is enabled and the admin has no second factor", async () => {
    db.appSetting.findUnique.mockResolvedValue({ value: "true" });
    const ctx = buildContext({
      user: { role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    const client = createRouterClient(testRouter404, { context: ctx });

    await expect(client.ping()).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Not found");
      return true;
    });
  });

  it("passes through to the handler when admin appears in a comma-separated role list", async () => {
    const ctx = buildContext({ user: { role: "editor,admin", emailVerified: true } });
    const client = createRouterClient(testRouter404, { context: ctx });

    const result = await client.ping();

    expect(result).toEqual({ ok: true });
  });
});
