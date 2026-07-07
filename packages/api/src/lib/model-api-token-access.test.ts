import { ORPCError } from "@orpc/server";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import {
  credentialLookupPrefix,
  hmacDigestForForwarderPurpose,
  PRODUCT_CREDENTIAL_PREFIXES,
} from "@ws-model-proxy/db/forwarder-security";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  authenticateModelApiTokenSecret,
  listVisibleModelTargetsForToken,
  resolveAllowlistedModelTargets,
} = await import("./model-api-token-access");
const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
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
    findUnique: MockInstance;
    update: MockInstance;
  };
  modelApiTokenAllowlistEntry: {
    findMany: MockInstance;
  };
};

const now = new Date("2026-01-01T00:00:00.000Z");

function modelPoolRow({
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

function directModelRow({
  id,
  userId,
  userSlug,
  cliSlug,
  endpointId,
  endpointSlug,
  upstreamModelId,
}: {
  id: string;
  userId: string;
  userSlug: string;
  cliSlug: string;
  endpointId: string;
  endpointSlug: string;
  upstreamModelId: string;
}) {
  return {
    id,
    userId,
    upstreamModelId,
    User: { slug: userSlug },
    Endpoint: {
      id: endpointId,
      slug: endpointSlug,
      CliDevice: { slug: cliSlug },
    },
  };
}

describe("modelApiTokenAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticateModelApiTokenSecret", () => {
    it("authenticates an active model API token without exposing its digest", async () => {
      const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${"a".repeat(43)}`;
      const lookupPrefix = credentialLookupPrefix(rawSecret);
      const secretDigest = hmacDigestForForwarderPurpose({
        purpose: "modelApiToken",
        value: rawSecret,
      });

      db.modelApiToken.findUnique.mockResolvedValue({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix,
        secretDigest,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      });
      db.modelApiToken.update.mockResolvedValue({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix,
        expiresAt: null,
        lastUsedAt: now,
      });

      const result = await authenticateModelApiTokenSecret(rawSecret);

      expect(result).toEqual({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix,
        expiresAt: null,
        lastUsedAt: now,
      });
      expect(JSON.stringify(result)).not.toContain(secretDigest);
      expect(db.modelApiToken.update).toHaveBeenCalledWith({
        where: { id: "token-id" },
        data: { lastUsedAt: expect.any(Date) },
        select: {
          id: true,
          userId: true,
          scopeMode: true,
          lookupPrefix: true,
          expiresAt: true,
          lastUsedAt: true,
        },
      });
    });

    it("rejects revoked model API tokens", async () => {
      const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${"b".repeat(43)}`;
      db.modelApiToken.findUnique.mockResolvedValue({
        id: "revoked-token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix: credentialLookupPrefix(rawSecret),
        secretDigest: hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: rawSecret,
        }),
        lastUsedAt: null,
        revokedAt: now,
        expiresAt: null,
      });

      await expect(authenticateModelApiTokenSecret(rawSecret)).resolves.toBeNull();
      expect(db.modelApiToken.update).not.toHaveBeenCalled();
    });

    it("rejects tokens whose digest does not match the presented secret", async () => {
      const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${"c".repeat(43)}`;
      db.modelApiToken.findUnique.mockResolvedValue({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        lookupPrefix: credentialLookupPrefix(rawSecret),
        secretDigest: hmacDigestForForwarderPurpose({
          purpose: "modelApiToken",
          value: `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${"d".repeat(43)}`,
        }),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
      });

      await expect(authenticateModelApiTokenSecret(rawSecret)).resolves.toBeNull();
      expect(db.modelApiToken.update).not.toHaveBeenCalled();
    });
  });

  describe("listVisibleModelTargetsForToken", () => {
    it("resolves ALL_VISIBLE pools from current grants on every call", async () => {
      const ownedPool = modelPoolRow({
        id: "owned-pool-id",
        userId: "user-id",
        userSlug: "owner",
        slug: "owned",
        name: "Owned",
      });
      const firstGrantedPool = modelPoolRow({
        id: "first-grant-pool-id",
        userId: "other-user-id",
        userSlug: "team-a",
        slug: "shared-a",
        name: "Shared A",
      });
      const secondGrantedPool = modelPoolRow({
        id: "second-grant-pool-id",
        userId: "third-user-id",
        userSlug: "team-b",
        slug: "shared-b",
        name: "Shared B",
      });

      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([ownedPool]);
      db.poolGrant.findMany
        .mockResolvedValueOnce([{ ModelPool: firstGrantedPool }])
        .mockResolvedValueOnce([{ ModelPool: secondGrantedPool }]);

      const token = {
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE" as const,
      };

      const first = await listVisibleModelTargetsForToken(token);
      const second = await listVisibleModelTargetsForToken(token);

      expect(first.modelPools.map((pool) => pool.modelId)).toEqual([
        poolModelId({ userSlug: "owner", poolSlug: "owned" }),
        poolModelId({ userSlug: "team-a", poolSlug: "shared-a" }),
      ]);
      expect(second.modelPools.map((pool) => pool.modelId)).toEqual([
        poolModelId({ userSlug: "owner", poolSlug: "owned" }),
        poolModelId({ userSlug: "team-b", poolSlug: "shared-b" }),
      ]);
    });

    it("intersects ALLOWLIST entries with current visibility", async () => {
      const grantedPool = modelPoolRow({
        id: "granted-pool-id",
        userId: "other-user-id",
        userSlug: "team-a",
        slug: "shared",
        name: "Shared",
      });

      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([]);
      db.poolGrant.findMany
        .mockResolvedValueOnce([{ ModelPool: grantedPool }])
        .mockResolvedValueOnce([]);
      db.modelApiTokenAllowlistEntry.findMany.mockResolvedValue([
        {
          target: "MODEL_POOL",
          discoveredModelId: null,
          modelPoolId: "granted-pool-id",
        },
      ]);

      const token = {
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALLOWLIST" as const,
      };

      const beforeGrantRemoval = await listVisibleModelTargetsForToken(token);
      const afterGrantRemoval = await listVisibleModelTargetsForToken(token);

      expect(beforeGrantRemoval.modelPools).toHaveLength(1);
      expect(afterGrantRemoval.modelPools).toHaveLength(0);
    });

    it("preserves pool grant and allowlist visibility across pool slug changes by internal id", async () => {
      const renamedGrantedPool = modelPoolRow({
        id: "granted-pool-id",
        userId: "other-user-id",
        userSlug: "team-a",
        slug: "renamed-shared",
        name: "Shared",
      });

      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([]);
      db.poolGrant.findMany.mockResolvedValue([{ ModelPool: renamedGrantedPool }]);
      db.modelApiTokenAllowlistEntry.findMany.mockResolvedValue([
        {
          target: "MODEL_POOL",
          discoveredModelId: null,
          modelPoolId: "granted-pool-id",
        },
      ]);

      const result = await listVisibleModelTargetsForToken({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALLOWLIST",
      });

      expect(result.modelPools).toEqual([
        expect.objectContaining({
          id: "granted-pool-id",
          poolSlug: "renamed-shared",
          modelId: poolModelId({ userSlug: "team-a", poolSlug: "renamed-shared" }),
        }),
      ]);
    });

    it("serializes and resolves dotted pool model ids", async () => {
      const ownedPool = modelPoolRow({
        id: "owned-pool-id",
        userId: "user-id",
        userSlug: "owner",
        slug: "gpt-4.1-mini",
        name: "GPT 4.1 Mini",
      });

      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([ownedPool]);
      db.poolGrant.findMany.mockResolvedValue([]);

      const visible = await listVisibleModelTargetsForToken({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
      });

      expect(visible.modelPools).toEqual([
        expect.objectContaining({
          id: "owned-pool-id",
          poolSlug: "gpt-4.1-mini",
          modelId: "owner/gpt-4.1-mini",
        }),
      ]);

      const resolved = await resolveAllowlistedModelTargets({
        userId: "user-id",
        modelIds: ["owner/gpt-4.1-mini"],
      });

      expect(resolved.modelPools).toEqual([
        expect.objectContaining({
          id: "owned-pool-id",
          modelId: "owner/gpt-4.1-mini",
        }),
      ]);
    });

    it("serializes direct model ids with reserved upstream characters while keeping allowlists tied to internal ids", async () => {
      const upstreamModelId = "org/model%20 with spaces:vision.v1";
      db.discoveredModel.findMany.mockResolvedValue([
        directModelRow({
          id: "renamed-model-id",
          userId: "user-id",
          userSlug: "owner",
          cliSlug: "desktop",
          endpointId: "endpoint-id",
          endpointSlug: "local",
          upstreamModelId,
        }),
      ]);
      db.modelPool.findMany.mockResolvedValue([]);
      db.poolGrant.findMany.mockResolvedValue([]);
      db.modelApiTokenAllowlistEntry.findMany.mockResolvedValue([
        {
          target: "DIRECT_MODEL",
          discoveredModelId: "renamed-model-id",
          modelPoolId: null,
        },
      ]);

      const result = await listVisibleModelTargetsForToken({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALLOWLIST",
      });

      expect(result.directModels).toEqual([
        {
          target: "DIRECT_MODEL",
          id: "renamed-model-id",
          modelId: directModelId({
            userSlug: "owner",
            cliSlug: "desktop",
            endpointSlug: "local",
            upstreamModelId,
          }),
          upstreamModelId,
          ownerUserId: "user-id",
          ownerUserSlug: "owner",
          endpointId: "endpoint-id",
          endpointSlug: "local",
          cliDeviceSlug: "desktop",
        },
      ]);
      expect(result.directModels[0]?.modelId).toContain("org%2Fmodel%2520%20with%20spaces%3A");
      expect(result.directModels[0]?.modelId).toContain(".v1");
    });
  });

  describe("resolveAllowlistedModelTargets", () => {
    it("throws FORBIDDEN for an inaccessible canonical model id", async () => {
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([]);
      db.poolGrant.findMany.mockResolvedValue([]);

      await expect(
        resolveAllowlistedModelTargets({
          userId: "user-id",
          modelIds: ["other-user/cli/endpoint/gpt-4o"],
        }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("FORBIDDEN");
        return true;
      });
    });
  });
});
