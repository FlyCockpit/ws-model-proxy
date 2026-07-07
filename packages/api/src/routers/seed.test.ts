import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — handlers read env.NODE_ENV at call time, so flipping this
// between tests exercises the dev vs production confirm-phrase branches.
const envMock = { NODE_ENV: "development" as "development" | "production" | "test" };
vi.mock("@ws-model-proxy/env/server", () => ({
  env: envMock,
}));

const runSeedMock = vi.fn(async () => ({ summary: ["seeded"] }));
vi.mock("@ws-model-proxy/db/seed", () => ({
  runSeed: runSeedMock,
}));

// `../index` imports the Prisma client at module load (the force-2FA gate in
// adminOr404Procedure reads appSetting), so the db boundary must be mocked or
// @ws-model-proxy/db's createEnv() chain throws "Invalid environment variables" in CI
// (no DATABASE_URL). mockDeep's findUnique returns undefined →
// force2fa resolves false, leaving these confirm-phrase tests unaffected.
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { seedRouter } = await import("./seed");

function buildContext(role: "admin" | "user" | null): Context {
  if (role === null) return { session: null };
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role,
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
      session: {
        id: "test-session-id",
        userId: "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
      },
    } as Session,
  };
}

describe("seedRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.NODE_ENV = "development";
  });

  describe("info", () => {
    it("reports the dev confirm phrase and isProduction=false", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: false,
        requiredConfirmPhrase: "seed",
      });
    });

    it("reports the production phrase and isProduction=true in prod", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });
      expect(await client.info()).toEqual({
        isProduction: true,
        requiredConfirmPhrase: "SEED PRODUCTION",
      });
    });

    it("404s for non-admins (the surface must not be discoverable)", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.info()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });

  describe("run", () => {
    it("runs the seed inline when the confirm phrase matches", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      const result = await client.run({ confirm: "seed" });

      expect(result.result.summary).toEqual(["seeded"]);
      expect(typeof result.result.durationMs).toBe("number");
      expect(runSeedMock).toHaveBeenCalledOnce();
    });

    it("trims surrounding whitespace before comparing the phrase", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "  seed  " })).resolves.toMatchObject({
        result: { summary: ["seeded"] },
      });
    });

    it("rejects a wrong confirm phrase without enqueuing", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "yes" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(runSeedMock).not.toHaveBeenCalled();
    });

    it("requires the loud production phrase in prod (the dev phrase is rejected)", async () => {
      envMock.NODE_ENV = "production";
      const client = createRouterClient(seedRouter, { context: buildContext("admin") });

      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(runSeedMock).not.toHaveBeenCalled();

      await expect(client.run({ confirm: "SEED PRODUCTION" })).resolves.toMatchObject({
        result: { summary: ["seeded"] },
      });
    });

    it("404s for non-admins", async () => {
      const client = createRouterClient(seedRouter, { context: buildContext("user") });
      await expect(client.run({ confirm: "seed" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });
  });
});
