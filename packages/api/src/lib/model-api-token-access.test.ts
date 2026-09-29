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
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    BETTER_AUTH_SECRET: "test-better-auth-secret",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const {
  authenticateModelApiTokenSecret,
  effectiveProviderEgress,
  listVisibleModelTargetsWithExternalPermissionForToken,
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
  user: {
    findUnique: MockInstance;
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
    maxAttachmentBytes: null,
    optimisticBasicTranscription: false,
    protocolAdaptationEnabled: false,
    fallbackEnabled: false,
    fallbackForGrantees: false,
    allowLossyDeveloperRoleCollapse: false,
    recommendedSurfaceOverride: null,
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
    maxAttachmentBytes: null,
    User: { slug: userSlug },
    Endpoint: {
      id: endpointId,
      slug: endpointSlug,
      CliDevice: { slug: cliSlug },
    },
  };
}

describe("effectiveProviderEgress", () => {
  it("is true only when fallback is on and an external member is configured", () => {
    expect(effectiveProviderEgress({ fallbackEnabled: true, externalMemberCount: 1 })).toBe(true);
    expect(effectiveProviderEgress({ fallbackEnabled: true, externalMemberCount: 0 })).toBe(false);
    expect(effectiveProviderEgress({ fallbackEnabled: false, externalMemberCount: 3 })).toBe(false);
  });
});

/** Visible targets for a private-only token (the targets do not depend on consent). */
async function listVisibleModelTargetsForToken(token: {
  id: string;
  userId: string;
  scopeMode: "ALL_VISIBLE" | "ALLOWLIST";
}) {
  return (
    await listVisibleModelTargetsWithExternalPermissionForToken({ ...token, allowExternal: false })
  ).targets;
}

describe("modelApiTokenAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findUnique.mockResolvedValue({ banned: false, deletionRequestedAt: null });
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
      vi.mocked(prisma.$executeRaw).mockResolvedValueOnce(1);

      const result = await authenticateModelApiTokenSecret(rawSecret);

      expect(result).toEqual({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        // Private only unless a person allows external providers.
        allowExternal: false,
        lookupPrefix,
        expiresAt: null,
        lastUsedAt: expect.any(Date),
      });
      expect(JSON.stringify(result)).not.toContain(secretDigest);
      expect(db.modelApiToken.update).not.toHaveBeenCalled();
      // L1b: the lastUsedAt write never waits on a row lock (the E0 send
      // claim holds the token FOR SHARE while it waits on provider rows).
      const [strings, ...values] = vi.mocked(prisma.$executeRaw).mock.calls[0]!;
      const sql = Array.isArray(strings) ? strings.join("?") : "";
      expect(sql).toMatch(/UPDATE model_api_token SET "lastUsedAt"/);
      expect(sql).toContain("FOR NO KEY UPDATE SKIP LOCKED");
      expect(sql).toContain('"lastUsedAt" <= ?');
      expect(values[1]).toBe("token-id");
    });

    it.each([
      ["a recent use is debounced without a write", 10_000, undefined],
      ["a locked token row is skipped, keeping the previous value", 120_000, 0],
    ] as const)("%s", async (_label, ageMs, updatedRows) => {
      const rawSecret = `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${"e".repeat(43)}`;
      const previous = new Date(Date.now() - ageMs);
      db.modelApiToken.findUnique.mockResolvedValue({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
        allowExternal: true,
        lookupPrefix: credentialLookupPrefix(rawSecret),
        secretDigest: hmacDigestForForwarderPurpose({ purpose: "modelApiToken", value: rawSecret }),
        lastUsedAt: previous,
        revokedAt: null,
        expiresAt: null,
      });
      if (updatedRows !== undefined)
        vi.mocked(prisma.$executeRaw).mockResolvedValueOnce(updatedRows);
      const result = await authenticateModelApiTokenSecret(rawSecret);
      expect(result).toMatchObject({ id: "token-id", allowExternal: true, lastUsedAt: previous });
      expect(vi.mocked(prisma.$executeRaw)).toHaveBeenCalledTimes(
        updatedRows === undefined ? 0 : 1,
      );
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
      expect(vi.mocked(prisma.$executeRaw)).not.toHaveBeenCalled();
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
      expect(vi.mocked(prisma.$executeRaw)).not.toHaveBeenCalled();
    });
  });

  describe("listVisibleModelTargetsForToken", () => {
    it("does not expose an invalid recommended surface read from storage", async () => {
      const ownedPool = {
        ...modelPoolRow({
          id: "owned-pool-id",
          userId: "user-id",
          userSlug: "owner",
          slug: "owned",
          name: "Owned",
        }),
        recommendedSurfaceOverride: "UNSUPPORTED_FUTURE_SURFACE",
        fallbackEnabled: true,
        PoolMembers: [{ id: "external-member", tier: "PUBLIC_OVERFLOW" }],
      };
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([ownedPool]);
      db.poolGrant.findMany.mockResolvedValue([]);

      const result = await listVisibleModelTargetsForToken({
        id: "token-id",
        userId: "user-id",
        scopeMode: "ALL_VISIBLE",
      });

      expect(result.modelPools[0]?.recommendedSurfaceOverride).toBeNull();
      expect(result.modelPools[0]).toMatchObject({
        fallbackEnabled: true,
        fallbackForGrantees: false,
        externalMemberCount: 1,
        effectiveProviderEgress: true,
      });
      expect(db.modelPool.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            PoolMembers: {
              where: {
                tier: "PUBLIC_OVERFLOW",
                ExecutionTarget: { providerModelId: { not: null } },
              },
              select: {
                id: true,
                tier: true,
                ExecutionTarget: {
                  select: {
                    ProviderModel: {
                      select: { ProviderAccount: { select: { label: true, providerType: true } } },
                    },
                  },
                },
              },
            },
          }),
        }),
      );
      expect(JSON.stringify(db.modelPool.findMany.mock.calls)).not.toContain("isNot");
    });

    it("derives the token's external consent: ALL_VISIBLE all-or-nothing, ALLOWLIST per pool", async () => {
      const first = modelPoolRow({
        id: "first-pool",
        userId: "user-id",
        userSlug: "owner",
        slug: "first",
        name: "First",
      });
      const second = modelPoolRow({
        id: "second-pool",
        userId: "user-id",
        userSlug: "owner",
        slug: "second",
        name: "Second",
      });
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([first, second]);
      db.poolGrant.findMany.mockResolvedValue([]);
      db.modelApiTokenAllowlistEntry.findMany.mockResolvedValue([
        {
          target: "MODEL_POOL",
          discoveredModelId: null,
          modelPoolId: "first-pool",
          includeExternal: true,
        },
        {
          target: "MODEL_POOL",
          discoveredModelId: null,
          modelPoolId: "second-pool",
          includeExternal: false,
        },
      ]);
      const permission = async (scopeMode: "ALL_VISIBLE" | "ALLOWLIST", allowExternal: boolean) =>
        [
          ...(
            await listVisibleModelTargetsWithExternalPermissionForToken({
              id: "token-id",
              userId: "user-id",
              scopeMode,
              allowExternal,
            })
          ).externalPoolIds,
        ].sort();

      // Private only by default, whatever the scope.
      expect(await permission("ALL_VISIBLE", false)).toEqual([]);
      expect(await permission("ALLOWLIST", false)).toEqual([]);
      // ALL_VISIBLE is all-or-nothing.
      expect(await permission("ALL_VISIBLE", true)).toEqual(["first-pool", "second-pool"]);
      // ALLOWLIST also needs the pool entry's includeExternal.
      expect(await permission("ALLOWLIST", true)).toEqual(["first-pool"]);
    });

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
        .mockResolvedValueOnce([{ id: "grant-a", ModelPool: firstGrantedPool }])
        .mockResolvedValueOnce([{ id: "grant-b", ModelPool: secondGrantedPool }]);

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
      expect(first.modelPools.map((pool) => pool.accessGrantId)).toEqual([null, "grant-a"]);
      expect(second.modelPools.map((pool) => pool.accessGrantId)).toEqual([null, "grant-b"]);
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
        .mockResolvedValueOnce([{ id: "grant-before-removal", ModelPool: grantedPool }])
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

    // #76: a banned (active ban) or deletion-marked owner's pools are hidden
    // from every grantee; an expired temporary ban no longer hides them.
    it.each([
      ["indefinite ban", { banned: true, banExpires: null }, false],
      [
        "temporary ban in force",
        { banned: true, banExpires: new Date(Date.now() + 60_000) },
        false,
      ],
      ["expired temporary ban", { banned: true, banExpires: new Date(Date.now() - 1_000) }, true],
      ["lifted ban", { banned: false, banExpires: null }, true],
      ["deletion mark", { deletionRequestedAt: new Date() }, false],
      [
        "deletion mark with an expired ban",
        { banned: true, banExpires: new Date(Date.now() - 1_000), deletionRequestedAt: new Date() },
        false,
      ],
    ] as const)(
      "hides a granted pool whose owner has a %s: visible=%s",
      async (_label, owner, visible) => {
        const row = modelPoolRow({
          id: "granted-pool-id",
          userId: "other-user-id",
          userSlug: "team-a",
          slug: "shared",
          name: "Shared",
        });
        db.discoveredModel.findMany.mockResolvedValue([]);
        db.modelPool.findMany.mockResolvedValue([]);
        db.poolGrant.findMany.mockResolvedValue([
          { id: "grant", ModelPool: { ...row, User: { ...row.User, ...owner } } },
        ]);
        const { listVisibleModelTargetsForUser } = await import("./model-api-token-access");
        const result = await listVisibleModelTargetsForUser("user-id");
        expect(result.modelPools.map((pool) => pool.id)).toEqual(
          visible ? ["granted-pool-id"] : [],
        );
        // Hidden pools cannot be named in an allowlist either.
        if (!visible)
          await expect(
            resolveAllowlistedModelTargets({
              userId: "user-id",
              modelIds: [poolModelId({ userSlug: "team-a", poolSlug: "shared" })],
            }),
          ).rejects.toSatisfy((error: ORPCError) => error.code === "FORBIDDEN");
      },
    );

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
      db.poolGrant.findMany.mockResolvedValue([
        { id: "renamed-grant", ModelPool: renamedGrantedPool },
      ]);
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
          accessGrantId: "renamed-grant",
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
          maxAttachmentBytes: null,
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

    it("asks for the plain pool name instead of allowlisting an :external variant", async () => {
      db.discoveredModel.findMany.mockResolvedValue([]);
      db.modelPool.findMany.mockResolvedValue([
        modelPoolRow({
          id: "owned-pool-id",
          userId: "user-id",
          userSlug: "owner",
          slug: "owned",
          name: "Owned",
        }),
      ]);
      db.poolGrant.findMany.mockResolvedValue([]);

      await expect(
        resolveAllowlistedModelTargets({ userId: "user-id", modelIds: ["owner/owned:external"] }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error.code).toBe("BAD_REQUEST");
        expect(error.message).toContain("plain name");
        return true;
      });
    });
  });
});

// E0 uses the same authoritative statement-clock decision on arrival and
// after provider locks; the latter must not reuse transaction-start now().
describe("external requester validity SQL", () => {
  const identity = {
    requesterUserId: "owner",
    ownerUserId: "owner",
    poolId: "pool",
    modelApiTokenId: null,
    accessGrantId: null,
  };

  it.each(["entry", "post-lock"] as const)("uses a coherent DB decision at %s", async (phase) => {
    const { readExternalConsentDenial, recheckExternalSendRequesterValidity } = await import(
      "./model-api-token-access"
    );
    const raw = vi
      .mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([
        { tokenValid: false, scopeMode: null, requesterValid: true, ownerValid: true },
      ]);
    raw.mockClear();
    const result =
      phase === "entry"
        ? await readExternalConsentDenial(identity)
        : await recheckExternalSendRequesterValidity(prisma, identity);
    expect(result).toBeNull();
    const [strings, ...values] = raw.mock.calls[0]!;
    const sql = Array.isArray(strings) ? strings.join("?") : "";
    expect(sql).toContain('t."expiresAt" > statement_timestamp()');
    expect(sql).toContain('u."banExpires" < statement_timestamp()');
    expect(sql).toContain('u."deletionRequestedAt" IS NULL');
    // #76: the pool owner's row, by the same rule in the same statement.
    expect(sql).toContain('o."banExpires" < statement_timestamp()');
    expect(sql).toContain('o."deletionRequestedAt" IS NULL');
    expect(sql).toContain("o.banned IS NOT TRUE");
    expect(sql).toContain('t."revokedAt" IS NULL');
    expect(sql).not.toMatch(/FOR (SHARE|UPDATE)|\bnow\(\)/);
    expect(values).toEqual(["owner", null, "owner", "owner"]);
  });

  it.each([
    [true, true, true, null],
    [false, true, true, "TOKEN_CONSENT_WITHDRAWN"],
    [true, false, true, "REQUESTER_ACCESS_BLOCKED"],
    [true, true, false, "POOL_OWNER_INACTIVE"],
    [true, false, false, "REQUESTER_ACCESS_BLOCKED"],
    [true, true, undefined, "POOL_OWNER_INACTIVE"],
  ] as const)(
    "consumes tokenValid=%s, requesterValid=%s, ownerValid=%s without a later clock comparison",
    async (tokenValid, requesterValid, ownerValid, expected) => {
      const { recheckExternalSendRequesterValidity } = await import("./model-api-token-access");
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
        { tokenValid, requesterValid, ownerValid, scopeMode: "ALL_VISIBLE" },
      ]);
      await expect(
        recheckExternalSendRequesterValidity(prisma, { ...identity, modelApiTokenId: "token" }),
      ).resolves.toBe(expected);
    },
  );

  it("fails closed on an absent requester result", async () => {
    const { recheckExternalSendRequesterValidity } = await import("./model-api-token-access");
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    await expect(recheckExternalSendRequesterValidity(prisma, identity)).resolves.toBe(
      "REQUESTER_ACCESS_BLOCKED",
    );
  });
});

describe("static external availability for each viewer", () => {
  it.each([
    [true, true, true, false, 1, true],
    [true, false, true, false, 1, false],
    [true, false, true, true, 1, true],
    [false, true, true, true, 1, false],
    [true, true, false, true, 1, false],
    [true, true, true, true, 0, false],
  ])(
    "switch %s owner %s enabled %s grantees %s members %s -> %s",
    async (enabled, owner, fallbackEnabled, fallbackForGrantees, memberCount, expected) => {
      const { env } = await import("@ws-model-proxy/env/server");
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = enabled;
      try {
        const row = {
          ...modelPoolRow({
            id: "pool",
            userId: "owner",
            userSlug: "owner",
            slug: "pool",
            name: "Pool",
          }),
          fallbackEnabled,
          fallbackForGrantees,
          PoolMembers: Array.from({ length: memberCount }, () => ({
            tier: "PUBLIC_OVERFLOW",
            healthStatus: "UNHEALTHY",
            routingStatus: "DISABLED",
          })),
        };
        db.discoveredModel.findMany.mockResolvedValue([]);
        db.modelPool.findMany.mockResolvedValue(owner ? [row] : []);
        db.poolGrant.findMany.mockResolvedValue(owner ? [] : [{ id: "grant", ModelPool: row }]);
        const result = await listVisibleModelTargetsForToken({
          id: "token",
          userId: owner ? "owner" : "grantee",
          scopeMode: "ALL_VISIBLE",
        });
        expect(result.modelPools[0]?.effectiveProviderEgress).toBe(expected);
      } finally {
        env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
      }
    },
  );

  it.each([
    // grantees, own key declared + chosen, switch -> routes
    [true, false, true, ["pool-fallback"]],
    [false, true, true, ["own-key"]],
    [true, true, true, ["pool-fallback", "own-key"]],
    [false, false, true, []],
    [true, true, false, []],
  ] as const)(
    "grantee routes: owner pays %s own key %s switch %s -> %j",
    async (fallbackForGrantees, ownKey, enabled, expected) => {
      const { env } = await import("@ws-model-proxy/env/server");
      env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = enabled;
      try {
        const row = {
          ...modelPoolRow({
            id: "pool",
            userId: "owner",
            userSlug: "owner",
            slug: "pool",
            name: "Pool",
          }),
          fallbackEnabled: true,
          fallbackForGrantees,
          externalEquivalentModel: "vendor/model",
          PoolMembers: [{ tier: "PUBLIC_OVERFLOW" }],
        };
        db.discoveredModel.findMany.mockResolvedValue([]);
        db.modelPool.findMany.mockResolvedValue([]);
        db.poolGrant.findMany.mockResolvedValue([
          {
            id: "grant",
            ModelPool: row,
            FallbackPreferences: ownKey ? [{ providerModelId: "own-provider-model" }] : [],
          },
        ]);
        const result = await listVisibleModelTargetsForToken({
          id: "token",
          userId: "grantee",
          scopeMode: "ALL_VISIBLE",
        });
        expect(result.modelPools[0]?.externalRoutes).toEqual(expected);
        expect(result.modelPools[0]?.effectiveProviderEgress).toBe(expected.length > 0);
        // Only a ready preference counts: live model and account, ACTIVE credential.
        expect(db.poolGrant.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({
              FallbackPreferences: {
                where: {
                  ProviderModel: {
                    enabled: true,
                    deletedAt: null,
                    ProviderAccount: {
                      enabled: true,
                      deletedAt: null,
                      CurrentCredential: { status: "ACTIVE" },
                    },
                  },
                },
                select: { providerModelId: true },
              },
            }),
          }),
        );
      } finally {
        env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = true;
      }
    },
  );

  it("gives the owner the pool-fallback route only", async () => {
    const row = {
      ...modelPoolRow({
        id: "pool",
        userId: "owner",
        userSlug: "owner",
        slug: "pool",
        name: "Pool",
      }),
      fallbackEnabled: true,
      PoolMembers: [{ tier: "PUBLIC_OVERFLOW" }],
    };
    db.discoveredModel.findMany.mockResolvedValue([]);
    db.modelPool.findMany.mockResolvedValue([row]);
    db.poolGrant.findMany.mockResolvedValue([]);
    const result = await listVisibleModelTargetsForToken({
      id: "token",
      userId: "owner",
      scopeMode: "ALL_VISIBLE",
    });
    expect(result.modelPools[0]?.externalRoutes).toEqual(["pool-fallback"]);
  });
});

it("discloses only recognized coarse types, deduplicated, and never grantee account labels", async () => {
  const { poolProviderDisclosure } = await import("./effective-provider-egress");
  const input = {
    isOwner: false,
    hasLiveGrant: true,
    providerEgressEnabled: true,
    fallbackEnabled: true,
    fallbackForGrantees: true,
    members: ["openrouter", "openai", "openrouter", "owner-private-custom-type"].map(
      (providerType) => ({
        tier: "PUBLIC_OVERFLOW",
        providerType,
        accountLabel: "Private owner label",
      }),
    ),
  };
  expect(poolProviderDisclosure(input)).toEqual({
    effectiveProviderEgress: true,
    providerAccountLabels: [],
    providerTypes: ["openai", "openrouter"],
  });
  expect(poolProviderDisclosure({ ...input, hasLiveGrant: false })).toEqual({
    effectiveProviderEgress: false,
    providerAccountLabels: [],
    providerTypes: [],
  });
});
