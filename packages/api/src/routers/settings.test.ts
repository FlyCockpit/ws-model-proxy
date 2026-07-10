import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forceTwoFactorPolicy = vi.hoisted(() => ({
  invalidateForceTwoFactorPolicyCache: vi.fn(),
  isForceTwoFactorRequired: vi.fn(),
}));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => forceTwoFactorPolicy);

import type { Context } from "../context";
import { settingsRouter } from "./settings";

// Mock @ws-model-proxy/db before importing the module
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

// Mock @ws-model-proxy/env/server so adminOr404Procedure can load without a real .env.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {},
}));

// Re-import the mocked module so we can configure return values
const { default: prisma } = await import("@ws-model-proxy/db");

// Type-safe handle to the mocked Prisma methods
const db = prisma as unknown as {
  appSetting: {
    findMany: MockInstance;
    upsert: MockInstance;
  };
  user: {
    findUnique: MockInstance;
    update: MockInstance;
  };
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

describe("settingsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceTwoFactorPolicy.isForceTwoFactorRequired.mockResolvedValue(false);
  });

  describe("getAll", () => {
    it("returns allowlisted settings as a key-value map and filters at the DB", async () => {
      db.appSetting.findMany.mockResolvedValue([
        { key: "force2fa", value: "false" },
        { key: "signupEnabled", value: "true" },
      ]);

      const ctx = buildContext(); // authenticated user
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({ force2fa: "false", signupEnabled: "true" });
      expect(db.appSetting.findMany).toHaveBeenCalledOnce();
      // Verify the allowlist is enforced at the query level so non-allowlisted
      // keys (e.g. future secrets/integration flags) never leave the DB.
      const call = db.appSetting.findMany.mock.calls[0]?.[0] as {
        where: { key: { in: string[] } };
      };
      expect(call.where.key.in).toContain("force2fa");
      expect(call.where.key.in).toContain("signupEnabled");
      expect(call.where.key.in).not.toContain("siteName");
    });

    it("remains readable when force2fa is enabled and the user has not enrolled yet", async () => {
      db.appSetting.findMany.mockResolvedValue([{ key: "force2fa", value: "true" }]);

      const ctx = buildContext({ user: { twoFactorEnabled: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).resolves.toEqual({ force2fa: "true" });
    });

    it("returns an empty object when no settings exist", async () => {
      db.appSetting.findMany.mockResolvedValue([]);

      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({});
    });

    it("throws UNAUTHORIZED for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });
  });

  describe("myNotificationPreferences", () => {
    it("returns the user's operational alert preference", async () => {
      db.user.findUnique.mockResolvedValue({ operationalAlerts: false });

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: false,
      });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        select: { operationalAlerts: true },
      });
    });

    it("defaults operational alerts on when the row is unavailable", async () => {
      db.user.findUnique.mockResolvedValue(null);

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: true,
      });
    });
  });

  describe("updateMyNotificationPreferences", () => {
    it("updates the user's operational alert preference", async () => {
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(
        client.updateMyNotificationPreferences({ operationalAlerts: false }),
      ).resolves.toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: { operationalAlerts: false },
      });
    });
  });

  describe("update", () => {
    it("upserts the setting and returns success", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "force2fa",
        value: "false",
      });

      const ctx = buildContext({ user: { role: "admin" } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.update({
        key: "force2fa",
        value: "false",
      });

      expect(result).toEqual({ success: true });
      expect(db.appSetting.upsert).toHaveBeenCalledWith({
        where: { key: "force2fa" },
        update: { value: "false" },
        create: { key: "force2fa", value: "false" },
      });
      expect(forceTwoFactorPolicy.invalidateForceTwoFactorPolicyCache).toHaveBeenCalledOnce();
    });

    it("permits admins to update signupEnabled", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "signupEnabled",
        value: "false",
      });

      const ctx = buildContext({ user: { role: "admin" } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(
        client.update({
          key: "signupEnabled",
          value: "false",
        }),
      ).resolves.toEqual({ success: true });
      expect(db.appSetting.upsert).toHaveBeenCalledWith({
        where: { key: "signupEnabled" },
        update: { value: "false" },
        create: { key: "signupEnabled", value: "false" },
      });
      expect(forceTwoFactorPolicy.invalidateForceTwoFactorPolicyCache).not.toHaveBeenCalled();
    });

    it("rejects unknown setting keys", async () => {
      const ctx = buildContext({ user: { role: "admin" } });
      const client = createRouterClient(settingsRouter, { context: ctx });
      const update = client.update as (input: { key: string; value: string }) => Promise<unknown>;

      await expect(update({ key: "siteName", value: "Nope" })).rejects.toThrow();
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("throws FORBIDDEN when enabling force2fa without 2FA on own account", async () => {
      const ctx = buildContext({
        user: { role: "admin", twoFactorEnabled: false },
      });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2fa", value: "true" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("FORBIDDEN");
          expect(error.message).toMatch(/enable 2FA/i);
          return true;
        },
      );

      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2fa", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND for non-admin users", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2fa", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND when admin email is not verified", async () => {
      const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2fa", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });
});
