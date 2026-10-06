import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory consent, provider and user rows the E0 send claim reads under its locks. */
const world = vi.hoisted(() => ({
  statements: [] as string[],
  pool: null as null | {
    Fallback: {
      mode: "OFF" | "OWNER" | "OWNER_AND_SHARES";
      paidWarmProtection: boolean;
      embeddingContract: unknown;
      ownKeyEquivalentModel: string | null;
    };
  },
  share: null as null | { id: string; granteeUserId: string; ownKeyProviderModelId: string | null },
  users: new Map<
    string,
    { banned: boolean | null; banExpires: Date | null; deletionRequestedAt: Date | null }
  >(),
  apiKey: null as null | {
    expiresAt: Date | null;
    scope: string;
    Pools: Array<{ poolId: string }>;
  },
  member: true,
  model: null as null | { enabled: boolean; accountEnabled: boolean },
  account: { providerType: "openrouter", allowDataCollection: true } as null | {
    providerType: string;
    allowDataCollection: boolean;
  },
  credential: null as null | Record<string, unknown>,
  credentialUpdates: 0,
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  const record = (strings: TemplateStringsArray, values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    world.statements.push(
      text.includes("wsmp_acquire_fences") ? `fences:${(values[0] as string[]).join(",")}` : text,
    );
  };
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return 0;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      record(strings, values);
      return strings.join("").includes("wsmp_acquire_fences") ? [{ acquired: true }] : [];
    },
    pool: { findFirst: async () => world.pool },
    share: {
      findFirst: async ({ where }: { where: { id: string; granteeUserId: string } }) =>
        world.share &&
        world.share.id === where.id &&
        world.share.granteeUserId === where.granteeUserId
          ? { ownKeyProviderModelId: world.share.ownKeyProviderModelId }
          : null,
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => {
          const user = world.users.get(id);
          return user ? [{ id, ...user }] : [];
        }),
    },
    apiKey: { findFirst: async () => world.apiKey },
    providerAccount: { findFirst: async () => world.account },
    providerModel: {
      findFirst: async () =>
        world.model
          ? {
              enabled: world.model.enabled,
              nativeCapabilities: null,
              Account: { enabled: world.model.accountEnabled },
            }
          : null,
    },
    poolMember: { findFirst: async () => (world.member ? { id: "member" } : null) },
    providerCredential: {
      findFirst: async () => world.credential,
      update: async () => {
        world.credentialUpdates += 1;
        return {};
      },
    },
  };
  return {
    default: { $transaction: async (work: (client: typeof tx) => unknown) => work(tx) },
    Prisma,
  };
});
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true, WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false },
}));

import {
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import {
  claimPublicProviderCredentialForSend,
  type ExternalSendConsentIdentity,
  type PublicProviderTarget,
} from "./public-overflow.js";

const keyring = parseProviderCredentialKeyring(`v1:${Buffer.alloc(32, 7).toString("base64")}`);
const active = { banned: false, banExpires: null, deletionRequestedAt: null };

function target(): PublicProviderTarget {
  return {
    poolMemberId: "member",
    executionTargetId: "target",
    publicOrder: 0,
    providerModelId: "model",
    upstreamModelId: "upstream",
    contextWindow: 1_000,
    maxOutputTokens: 100,
    protocol: "openai",
    providerAccountId: "account",
    endpointIdentity: "endpoint",
    endpointVersion: 1,
    concurrencyLimit: null,
    providerVersion: null,
    dataCollectionPolicy: null,
    baseUrl: "https://provider.example",
    authType: "BEARER",
    healthStatus: "HEALTHY",
    nativeProtocols: ["openai"],
    nativeSurfaces: ["openai-chat"],
    supportsStreaming: true,
    supportedFeatures: [],
    credential: {
      id: "credential",
      credentialType: "BEARER",
      keyVersion: "v1",
      aadVersion: 1,
      algorithm: "AES-256-GCM",
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
    },
  };
}

const ownerConsent: ExternalSendConsentIdentity = {
  requesterUserId: "owner",
  apiKeyId: "key",
  poolId: "pool",
  ownerUserId: "owner",
  shareId: null,
};
const granteeConsent: ExternalSendConsentIdentity = {
  requesterUserId: "grantee",
  apiKeyId: "grantee-key",
  poolId: "pool",
  ownerUserId: "owner",
  shareId: "share",
};

function claim(
  consent: ExternalSendConsentIdentity = ownerConsent,
  extra: { reason?: "LOCAL_SATURATED_PROTECTED"; userId?: string } = {},
) {
  return claimPublicProviderCredentialForSend({
    userId: extra.userId ?? "owner",
    target: target(),
    keyring,
    consent,
    reason: extra.reason,
  });
}

beforeEach(() => {
  world.statements.length = 0;
  world.pool = {
    Fallback: {
      mode: "OWNER",
      paidWarmProtection: false,
      embeddingContract: null,
      ownKeyEquivalentModel: null,
    },
  };
  world.share = { id: "share", granteeUserId: "grantee", ownKeyProviderModelId: null };
  world.users = new Map([
    ["owner", { ...active }],
    ["grantee", { ...active }],
  ]);
  world.apiKey = { expiresAt: null, scope: "ALL_POOLS", Pools: [] };
  world.member = true;
  world.model = { enabled: true, accountEnabled: true };
  world.account = { providerType: "openrouter", allowDataCollection: true };
  const sealed = encryptProviderCredential(
    "sk-test-secret",
    {
      credentialId: "credential",
      userId: "owner",
      providerAccountId: "account",
      credentialType: "BEARER",
      aadVersion: 1,
    },
    keyring,
  );
  world.credential = {
    id: "credential",
    credentialType: "BEARER",
    aadVersion: 1,
    algorithm: sealed.algorithm,
    keyVersion: sealed.keyVersion,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    authTag: sealed.authTag,
  };
  world.credentialUpdates = 0;
});

describe("E0 cloud send claim", () => {
  it("claims the current credential for the owner under OWNER mode", async () => {
    await expect(claim()).resolves.toEqual({
      claimed: true,
      secret: "sk-test-secret",
      dataCollectionPolicy: null,
    });
    expect(world.credentialUpdates).toBe(1);
  });

  it("takes the owner fences, consent rows, provider rows and users in order", async () => {
    world.pool!.Fallback.mode = "OWNER_AND_SHARES";
    await expect(claim(granteeConsent)).resolves.toMatchObject({ claimed: true });
    const order = world.statements.map((statement) =>
      statement.startsWith("fences:")
        ? statement
        : (statement.match(/FROM "?([a-z_]+)"? WHERE/)?.[1] ??
          (statement.includes("lock_timeout") ? "lock_timeout" : statement)),
    );
    expect(order).toEqual([
      "lock_timeout",
      "fences:00:owner:grantee,00:owner:owner",
      "pool",
      "pool_fallback",
      "share",
      "api_key",
      "pool_member",
      "provider_account",
      "provider_model",
      "provider_credential",
      "user",
    ]);
  });

  it("reads the D9 privacy switch under the account lock", async () => {
    world.account = { providerType: "openrouter", allowDataCollection: false };
    await expect(claim()).resolves.toMatchObject({ claimed: true, dataCollectionPolicy: "deny" });
  });

  it("refuses when the pool's cloud mode no longer covers the requester", async () => {
    world.pool!.Fallback.mode = "OFF";
    await expect(claim()).resolves.toEqual({ claimed: false, reason: "POOL_PRIVATE" });
    world.pool!.Fallback.mode = "OWNER";
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "GRANTEE_NOT_COVERED",
    });
    world.pool!.Fallback.mode = "OWNER_AND_SHARES";
    await expect(claim(granteeConsent)).resolves.toMatchObject({ claimed: true });
    expect(world.credentialUpdates).toBe(1);
  });

  it("refuses a revoked share, an expired or narrowed key, and blocked people", async () => {
    world.pool!.Fallback.mode = "OWNER_AND_SHARES";
    world.share = null;
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
    world.share = { id: "share", granteeUserId: "grantee", ownKeyProviderModelId: null };
    world.apiKey = { expiresAt: new Date(Date.now() - 1_000), scope: "ALL_POOLS", Pools: [] };
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "CALLER_CONSENT_WITHDRAWN",
    });
    world.apiKey = { expiresAt: null, scope: "SELECTED_POOLS", Pools: [] };
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
    world.apiKey = { expiresAt: null, scope: "ALL_POOLS", Pools: [] };
    world.users.set("grantee", { ...active, banned: true });
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_ACCESS_BLOCKED",
    });
    world.users.set("owner", { ...active, deletionRequestedAt: new Date() });
    await expect(claim(granteeConsent)).resolves.toEqual({
      claimed: false,
      reason: "POOL_OWNER_INACTIVE",
    });
    expect(world.credentialUpdates).toBe(0);
  });

  it("needs paid warm protection for a protected-saturation fallback", async () => {
    await expect(claim(ownerConsent, { reason: "LOCAL_SATURATED_PROTECTED" })).resolves.toEqual({
      claimed: false,
      reason: "PROVIDER_UNAVAILABLE",
    });
    world.pool!.Fallback.paidWarmProtection = true;
    await expect(
      claim(ownerConsent, { reason: "LOCAL_SATURATED_PROTECTED" }),
    ).resolves.toMatchObject({ claimed: true });
  });

  it("treats a removed member or disabled model as availability, not consent", async () => {
    world.member = false;
    await expect(claim()).resolves.toEqual({ claimed: false, reason: "PROVIDER_UNAVAILABLE" });
    world.member = true;
    world.model = { enabled: false, accountEnabled: true };
    await expect(claim()).resolves.toEqual({ claimed: false, reason: "PROVIDER_UNAVAILABLE" });
    world.model = null;
    await expect(claim()).resolves.toEqual({ claimed: false, reason: "PROVIDER_UNAVAILABLE" });
  });

  it("throws (nothing sent) when the credential rotated meanwhile", async () => {
    world.credential = null;
    await expect(claim()).rejects.toThrow("no longer current");
    expect(world.credentialUpdates).toBe(0);
  });

  it("refuses a consent whose owner flag disagrees with its share", async () => {
    await expect(claim({ ...ownerConsent, shareId: "share" })).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
    await expect(claim({ ...granteeConsent, shareId: null })).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
    expect(world.statements).toEqual([]);
  });

  it("lets own-key run while the pool's own cloud mode is off", async () => {
    world.pool!.Fallback.mode = "OFF";
    world.pool!.Fallback.ownKeyEquivalentModel = "openai/gpt-oss-120b";
    world.share = { id: "share", granteeUserId: "grantee", ownKeyProviderModelId: "model" };
    const sealed = world.credential!;
    // The share holder pays with their own credential (AAD bound to them).
    const own = encryptProviderCredential(
      "sk-grantee",
      {
        credentialId: "credential",
        userId: "grantee",
        providerAccountId: "account",
        credentialType: "BEARER",
        aadVersion: 1,
      },
      keyring,
    );
    world.credential = { ...sealed, ...own, algorithm: own.algorithm };
    await expect(
      claim({ ...granteeConsent, ownKeyProviderModelId: "model" }, { userId: "grantee" }),
    ).resolves.toMatchObject({ claimed: true, secret: "sk-grantee" });
  });

  it("requires the owner's equivalent-model consent and the share's choice for own-key", async () => {
    const ownKey = { ...granteeConsent, ownKeyProviderModelId: "model" };
    world.share = { id: "share", granteeUserId: "grantee", ownKeyProviderModelId: "model" };
    await expect(claim(ownKey, { userId: "grantee" })).resolves.toEqual({
      claimed: false,
      reason: "OWN_KEY_CONSENT_WITHDRAWN",
    });
    world.pool!.Fallback.ownKeyEquivalentModel = "openai/gpt-oss-120b";
    world.share.ownKeyProviderModelId = "other";
    await expect(claim(ownKey, { userId: "grantee" })).resolves.toEqual({
      claimed: false,
      reason: "OWN_KEY_CONSENT_WITHDRAWN",
    });
    // The payer of an own-key send is the share holder, never the pool owner.
    world.share.ownKeyProviderModelId = "model";
    await expect(claim(ownKey, { userId: "owner" })).resolves.toEqual({
      claimed: false,
      reason: "REQUESTER_NOT_VISIBLE",
    });
  });
});
