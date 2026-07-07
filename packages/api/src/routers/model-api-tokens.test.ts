import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import {
  PRODUCT_CREDENTIAL_PREFIXES,
  verifyForwarderHmacDigest,
} from "@ws-model-proxy/db/forwarder-security";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { modelApiTokensRouter } = await import("./model-api-tokens");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  appSetting: {
    findUnique: MockInstance;
  };
  discoveredModel: {
    findMany: MockInstance;
  };
  modelPool: {
    findMany: MockInstance;
  };
  poolGrant: {
    findMany: MockInstance;
  };
  modelApiToken: {
    findMany: MockInstance;
    create: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
};

type TokenCreateArgs = {
  data: {
    userId: string;
    name: string;
    scopeMode: string;
    lookupPrefix: string;
    secretDigest: string;
    expiresAt: Date | null;
    AllowlistEntries: {
      create: {
        target: string;
        discoveredModelId?: string;
        modelPoolId?: string;
      }[];
    };
  };
};

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const updatedAt = new Date("2026-01-01T00:00:00.000Z");

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
        id: "user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        locale: "en-US",
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt,
        updatedAt,
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt,
        updatedAt,
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

function directModelRow({
  id,
  userId = "user-id",
  userSlug = "owner",
  cliSlug = "desktop",
  endpointSlug = "openai",
  upstreamModelId = "gpt-4o",
}: {
  id: string;
  userId?: string;
  userSlug?: string;
  cliSlug?: string;
  endpointSlug?: string;
  upstreamModelId?: string;
}) {
  return {
    id,
    userId,
    upstreamModelId,
    User: { slug: userSlug },
    Endpoint: {
      id: `${id}-endpoint`,
      slug: endpointSlug,
      CliDevice: { slug: cliSlug },
    },
  };
}

function poolRow({
  id,
  userId,
  userSlug,
  slug,
  name,
}: {
  id: string;
  userId: string;
  userSlug: string;
  slug: string;
  name: string;
}) {
  return {
    id,
    userId,
    slug,
    name,
    description: null,
    User: { slug: userSlug },
  };
}

function mockTokenCreate() {
  db.modelApiToken.create.mockImplementation((args: unknown) => {
    const createArgs = args as TokenCreateArgs;
    return Promise.resolve({
      id: "token-id",
      createdAt,
      updatedAt,
      userId: createArgs.data.userId,
      name: createArgs.data.name,
      scopeMode: createArgs.data.scopeMode,
      lookupPrefix: createArgs.data.lookupPrefix,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: createArgs.data.expiresAt,
      AllowlistEntries: createArgs.data.AllowlistEntries.create.map((entry) => ({
        target: entry.target,
        discoveredModelId: entry.discoveredModelId ?? null,
        modelPoolId: entry.modelPoolId ?? null,
      })),
    });
  });
}

function seedVisibleModels() {
  const direct = directModelRow({ id: "direct-model-id" });
  const ownedPool = poolRow({
    id: "owned-pool-id",
    userId: "user-id",
    userSlug: "owner",
    slug: "owned-pool",
    name: "Owned Pool",
  });
  const grantedPool = poolRow({
    id: "granted-pool-id",
    userId: "other-user-id",
    userSlug: "team",
    slug: "shared-pool",
    name: "Shared Pool",
  });

  db.discoveredModel.findMany.mockResolvedValue([direct]);
  db.modelPool.findMany.mockResolvedValue([ownedPool]);
  db.poolGrant.findMany.mockResolvedValue([{ ModelPool: grantedPool }]);

  return {
    directModelId: directModelId({
      userSlug: "owner",
      cliSlug: "desktop",
      endpointSlug: "openai",
      upstreamModelId: "gpt-4o",
    }),
    ownedPoolId: poolModelId({ userSlug: "owner", poolSlug: "owned-pool" }),
    grantedPoolId: poolModelId({ userSlug: "team", poolSlug: "shared-pool" }),
  };
}

describe("modelApiTokensRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue({ value: "false" });
  });

  describe("create", () => {
    it("creates an ALLOWLIST token and returns the raw secret exactly once", async () => {
      const modelIds = seedVisibleModels();
      mockTokenCreate();

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      const result = await client.create({
        name: "Harness",
        scopeMode: "ALLOWLIST",
        modelIds: [modelIds.directModelId, modelIds.ownedPoolId, modelIds.grantedPoolId],
      });

      expect(result.secret.startsWith(PRODUCT_CREDENTIAL_PREFIXES.modelApiToken)).toBe(true);
      const randomPart = result.secret.slice(PRODUCT_CREDENTIAL_PREFIXES.modelApiToken.length);
      expect(randomPart).toHaveLength(43);
      expect(randomPart).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.token).toEqual({
        id: "token-id",
        createdAt,
        updatedAt,
        name: "Harness",
        scopeMode: "ALLOWLIST",
        lookupPrefix: expect.stringMatching(/^wsmp_model_[A-Za-z0-9_-]{12}$/),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        allowlist: {
          directModelCount: 1,
          modelPoolCount: 2,
        },
      });
      expect(JSON.stringify(result.token)).not.toContain(result.secret);

      const createCall = db.modelApiToken.create.mock.calls[0]?.[0] as TokenCreateArgs;
      expect(createCall.data.secretDigest).not.toBe(result.secret);
      expect(createCall.data.lookupPrefix).toBe(result.token.lookupPrefix);
      expect(
        verifyForwarderHmacDigest({
          purpose: "modelApiToken",
          value: result.secret,
          digest: createCall.data.secretDigest,
        }),
      ).toBe(true);
      expect(createCall.data.AllowlistEntries.create).toEqual(
        expect.arrayContaining([
          { target: "DIRECT_MODEL", discoveredModelId: "direct-model-id" },
          { target: "MODEL_POOL", modelPoolId: "owned-pool-id" },
          { target: "MODEL_POOL", modelPoolId: "granted-pool-id" },
        ]),
      );
    });

    it("keeps ALL_VISIBLE tokens dynamic by not persisting visible rows as allowlist entries", async () => {
      seedVisibleModels();
      mockTokenCreate();

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      const result = await client.create({
        name: "All visible",
        scopeMode: "ALL_VISIBLE",
      });

      expect(result.token.allowlist).toEqual({ directModelCount: 0, modelPoolCount: 0 });
      const createCall = db.modelApiToken.create.mock.calls[0]?.[0] as TokenCreateArgs;
      expect(createCall.data.AllowlistEntries.create).toEqual([]);
    });

    it("rejects another user's direct model canonical id", async () => {
      seedVisibleModels();
      mockTokenCreate();

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });
      const otherUserModelId = directModelId({
        userSlug: "other",
        cliSlug: "laptop",
        endpointSlug: "openai",
        upstreamModelId: "gpt-4o",
      });

      await expect(
        client.create({
          name: "Forbidden",
          scopeMode: "ALLOWLIST",
          modelIds: [otherUserModelId],
        }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.modelApiToken.create).not.toHaveBeenCalled();
    });

    it("rejects allowlist input for ALL_VISIBLE tokens", async () => {
      const modelIds = seedVisibleModels();
      mockTokenCreate();

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      await expect(
        client.create({
          name: "Invalid",
          scopeMode: "ALL_VISIBLE",
          modelIds: [modelIds.directModelId],
        }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("BAD_REQUEST");
        return true;
      });
      expect(db.modelApiToken.create).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("omits raw secrets and HMAC digests from token list responses", async () => {
      db.modelApiToken.findMany.mockResolvedValue([
        {
          id: "token-id",
          createdAt,
          updatedAt,
          userId: "user-id",
          name: "Harness",
          scopeMode: "ALLOWLIST",
          lookupPrefix: "wsmp_model_abcd1234EFGH",
          secretDigest: "digest-that-must-not-leak",
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          AllowlistEntries: [
            {
              target: "DIRECT_MODEL",
              discoveredModelId: "direct-model-id",
              modelPoolId: null,
            },
          ],
        },
      ]);

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      const result = await client.list();

      expect(result).toEqual([
        {
          id: "token-id",
          createdAt,
          updatedAt,
          name: "Harness",
          scopeMode: "ALLOWLIST",
          lookupPrefix: "wsmp_model_abcd1234EFGH",
          lastUsedAt: null,
          revokedAt: null,
          expiresAt: null,
          allowlist: {
            directModelCount: 1,
            modelPoolCount: 0,
          },
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("digest-that-must-not-leak");
      expect(JSON.stringify(result)).not.toContain("secretDigest");
      expect(db.modelApiToken.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { userId: "user-id", revokedAt: null },
        select: expect.not.objectContaining({ secretDigest: true }),
      });
    });
  });

  describe("preview", () => {
    it("returns canonical ids for selected visible allowlist targets", async () => {
      const modelIds = seedVisibleModels();

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      const result = await client.preview({
        scopeMode: "ALLOWLIST",
        modelIds: [modelIds.directModelId, modelIds.grantedPoolId],
      });

      expect(result.directModels.map((model) => model.id)).toEqual([modelIds.directModelId]);
      expect(result.modelPools.map((pool) => pool.id)).toEqual([modelIds.grantedPoolId]);
    });
  });

  describe("revoke", () => {
    it("revokes an owned token", async () => {
      db.modelApiToken.findUnique.mockResolvedValue({
        id: "token-id",
        userId: "user-id",
        revokedAt: null,
      });
      db.modelApiToken.update.mockResolvedValue({
        id: "token-id",
        createdAt,
        updatedAt,
        userId: "user-id",
        name: "Harness",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix: "wsmp_model_abcd1234EFGH",
        lastUsedAt: null,
        revokedAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
        AllowlistEntries: [],
      });

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      const result = await client.revoke({ id: "token-id" });

      expect(result.revokedAt).toEqual(new Date("2026-01-02T00:00:00.000Z"));
      expect(db.modelApiToken.update).toHaveBeenCalledWith({
        where: { id: "token-id" },
        data: { revokedAt: expect.any(Date) },
        select: expect.any(Object),
      });
    });

    it("hides tokens owned by another user", async () => {
      db.modelApiToken.findUnique.mockResolvedValue({
        id: "token-id",
        userId: "other-user-id",
        revokedAt: null,
      });

      const client = createRouterClient(modelApiTokensRouter, { context: buildContext() });

      await expect(client.revoke({ id: "token-id" })).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("NOT_FOUND");
        return true;
      });
      expect(db.modelApiToken.update).not.toHaveBeenCalled();
    });
  });
});
