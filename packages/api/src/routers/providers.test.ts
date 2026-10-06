import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DeepMockProxy, mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
const fenceLog = vi.hoisted(() => ({ held: [] as string[] }));
vi.mock("@ws-model-proxy/db/capacity-lock-order", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ws-model-proxy/db/capacity-lock-order")>();
  return {
    ...real,
    acquireFences: vi.fn(async (_tx: unknown, requested: Iterable<string>) => {
      fenceLog.held.push(...requested);
      return true;
    }),
    runCapacityOrderedTransaction: vi.fn(
      (db: { $transaction: (work: unknown) => unknown }, work: (tx: unknown) => unknown) =>
        db.$transaction(work),
    ),
  };
});
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: false,
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 7).toString("base64")}`,
  },
}));

import prisma from "@ws-model-proxy/db";
import type { CallerAuth } from "../contracts/auth-context";
import { CALLERS, contextFor, OWNER } from "./lane-c-test-helpers";
import { providersRouter } from "./providers";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const SECRET = "sk-or-v1-supersecretvalue-WXYZ";

function client(auth: CallerAuth = CALLERS.person()) {
  return createRouterClient(providersRouter, { context: contextFor(auth) });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) return error.code;
    throw error;
  }
  return undefined;
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    providerType: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authType: "BEARER",
    enabled: false,
    allowDataCollection: false,
    health: "UNKNOWN",
    healthCheckedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    CurrentCredential: { id: "cred-1", status: "ACTIVE", displaySuffix: "WXYZ", lastUsedAt: null },
    SpendCap: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockReset(db);
  fenceLog.held.length = 0;
  db.$transaction.mockImplementation(((work: (tx: PrismaClient) => unknown) => work(db)) as never);
  db.usageLedger.aggregate.mockResolvedValue({ _sum: { settledCost: null } } as never);
  db.spendReservation.aggregate.mockResolvedValue({ _sum: { reservedValue: null } } as never);
  db.providerAccount.findUniqueOrThrow.mockResolvedValue({
    currentCredentialId: "cred-1",
    baseUrl: "https://openrouter.ai/api/v1",
    endpointVersion: 1,
  } as never);
  db.spendCap.findUnique.mockResolvedValue(null);
});

const READ_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: OWNER,
  agentTokenId: "tok-r",
  level: "READ",
};
const API_KEY: CallerAuth = { kind: "api_key", userId: OWNER, apiKeyId: "key-1" };

/** Every write: provider keys and cloud spend are human-only. */
const HUMAN_ONLY: ReadonlyArray<[string, (c: ReturnType<typeof client>) => Promise<unknown>]> = [
  [
    "accounts.create",
    (c) =>
      c.accounts.create({
        providerType: "openrouter",
        label: "x",
        baseUrl: "https://openrouter.ai/api/v1",
        authType: "BEARER",
        secret: SECRET,
      }),
  ],
  ["accounts.update", (c) => c.accounts.update({ accountId: "acc-1", label: "y" })],
  ["accounts.delete", (c) => c.accounts.delete({ accountId: "acc-1" })],
  ["accounts.setEnabled", (c) => c.accounts.setEnabled({ accountId: "acc-1", enabled: true })],
  [
    "accounts.setDataCollection",
    (c) => c.accounts.setDataCollection({ accountId: "acc-1", allow: true }),
  ],
  ["credentials.replace", (c) => c.credentials.replace({ accountId: "acc-1", secret: SECRET })],
  ["credentials.revoke", (c) => c.credentials.revoke({ credentialId: "cred-1" })],
  ["credentials.test", (c) => c.credentials.test({ accountId: "acc-1" })],
  ["credentials.reencrypt", (c) => c.credentials.reencrypt({})],
  [
    "models.create",
    (c) => c.models.create({ accountId: "acc-1", upstreamModelId: "m", type: "LLM" }),
  ],
  ["models.update", (c) => c.models.update({ modelId: "pm-1", enabled: true })],
  ["models.delete", (c) => c.models.delete({ modelId: "pm-1" })],
  ["pricing.create", (c) => c.pricing.create({ modelId: "pm-1", currency: "USD", pricing: {} })],
  ["pricing.activate", (c) => c.pricing.activate({ versionId: "pv-1" })],
  ["pricing.retire", (c) => c.pricing.retire({ versionId: "pv-1" })],
  ["pricing.delete", (c) => c.pricing.delete({ versionId: "pv-1" })],
  ["spendCaps.set", (c) => c.spendCaps.set({ accountId: "acc-1", monthlyLimit: "25" })],
  ["spendCaps.clear", (c) => c.spendCaps.clear({ accountId: "acc-1" })],
];

describe("provider keys and cloud spend are human-only", () => {
  for (const [label, auth] of [
    ["a Full agent token", CALLERS.fullAgent()],
    ["a Read-only agent token", READ_AGENT],
    ["an OAuth access token", CALLERS.oauthAgent()],
    ["an API key", API_KEY],
    ["a cookie without the CSRF header", CALLERS.cookieWithoutCsrf()],
  ] as const)
    it(`refuses ${label} on every write, before touching the database`, async () => {
      for (const [name, call] of HUMAN_ONLY)
        expect(await codeOf(call(client(auth))), name).toBe("FORBIDDEN");
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.providerAccount.findFirst).not.toHaveBeenCalled();
      expect(db.providerCredential.findFirst).not.toHaveBeenCalled();
      expect(db.spendCap.create).not.toHaveBeenCalled();
      expect(fenceLog.held).toEqual([]);
    });

  it("lets agents read accounts and models without any secret", async () => {
    db.providerAccount.findMany.mockResolvedValue([accountRow()] as never);
    const { accounts } = await client(CALLERS.fullAgent()).accounts.list();
    expect(accounts[0]?.credential).toEqual({
      id: "cred-1",
      status: "ACTIVE",
      displaySuffix: "WXYZ",
      lastUsedAt: null,
    });
    expect(JSON.stringify(accounts)).not.toContain("supersecret");
    const select = db.providerAccount.findMany.mock.calls[0]?.[0]?.select as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(select)).not.toMatch(/ciphertext|nonce|authTag/);
  });
});

describe("providers (a person)", () => {
  it("creates a disabled account with an encrypted key and its endpoint identity", async () => {
    db.providerAccount.create.mockResolvedValue({ id: "acc-1", authType: "BEARER" } as never);
    db.providerCredential.create.mockResolvedValue({ id: "cred-1" } as never);
    db.providerAccount.findFirst.mockResolvedValue(accountRow() as never);
    const view = await client().accounts.create({
      providerType: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1/",
      authType: "BEARER",
      secret: SECRET,
    });
    expect(db.providerAccount.create.mock.calls[0]?.[0]?.data).toMatchObject({
      enabled: false,
      baseUrl: "https://openrouter.ai/api/v1",
      endpointIdentity: "https://openrouter.ai/api/v1",
      endpointVersion: 1,
    });
    const sealed = db.providerCredential.create.mock.calls[0]?.[0]?.data as {
      ciphertext: Uint8Array;
      displaySuffix: string;
    };
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("supersecret");
    expect(sealed.displaySuffix).toBe("WXYZ");
    expect(fenceLog.held).toEqual(["00:owner:owner-1"]);
    expect(view.enabled).toBe(false);
  });

  it("refuses a private base URL", async () => {
    expect(
      await codeOf(
        client().accounts.create({
          providerType: "generic",
          label: "local",
          baseUrl: "https://127.0.0.1/v1",
          authType: "API_KEY",
          secret: SECRET,
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(db.providerAccount.create).not.toHaveBeenCalled();
  });

  it("will not turn on an account without a key", async () => {
    db.providerAccount.findFirst.mockResolvedValue(
      accountRow({ CurrentCredential: null }) as never,
    );
    db.providerAccount.findUniqueOrThrow.mockResolvedValue({ currentCredentialId: null } as never);
    expect(await codeOf(client().accounts.setEnabled({ accountId: "acc-1", enabled: true }))).toBe(
      "BAD_REQUEST",
    );
  });

  it("a cap change bumps its version under the spend-cap fence", async () => {
    db.providerAccount.findFirst.mockResolvedValue(
      accountRow({ SpendCap: { id: "cap-1", monthlyLimit: "10", currency: "USD" } }) as never,
    );
    db.spendCap.findUnique.mockResolvedValue({ id: "cap-1", version: 3 } as never);
    const spend = await client().spendCaps.set({ accountId: "acc-1", monthlyLimit: "25" });
    expect(db.spendCap.update.mock.calls[0]?.[0]?.data).toEqual({
      monthlyLimit: "25",
      currency: "USD",
      version: 4,
    });
    expect(fenceLog.held).toEqual(["00:owner:owner-1", "04:spend-cap:cap-1"]);
    expect(spend.currency).toBe("USD");
  });

  it("replacing a key revokes, creates, then marks the old one replaced", async () => {
    db.providerAccount.findFirst.mockResolvedValueOnce({
      id: "acc-1",
      authType: "BEARER",
      currentCredentialId: "cred-1",
    } as never);
    db.providerAccount.findFirst.mockResolvedValue(accountRow() as never);
    await client().credentials.replace({ accountId: "acc-1", secret: SECRET });
    const created = db.providerCredential.create.mock.calls[0]?.[0]?.data as
      | { id: string }
      | undefined;
    const newId = created?.id;
    expect(db.providerCredential.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "REVOKED",
    });
    expect(db.providerCredential.update.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "REPLACED",
      replacedById: newId,
      revokedAt: null,
    });
    expect(db.providerAccount.update.mock.calls[0]?.[0]?.data).toEqual({
      currentCredentialId: newId,
    });
  });

  it("another person's account is not found", async () => {
    db.providerAccount.findFirst.mockResolvedValue(null);
    expect(await codeOf(client().accounts.get({ accountId: "acc-x" }))).toBe("NOT_FOUND");
    expect(db.providerAccount.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "acc-x",
      userId: OWNER,
      deletedAt: null,
    });
  });
});

describe("provider review follow-ups", () => {
  it("refuses a negative cap and negative prices", async () => {
    expect(await codeOf(client().spendCaps.set({ accountId: "acc-1", monthlyLimit: "-1" }))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await codeOf(
        client().pricing.create({
          modelId: "pm-1",
          currency: "USD",
          pricing: { input: "-1", output: "2" },
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("stores prices in the shape billing reads and never reuses a version name", async () => {
    db.providerModel.findFirst.mockResolvedValue({
      id: "pm-1",
      providerAccountId: "acc-1",
    } as never);
    db.providerPricingVersion.findMany.mockResolvedValue([{ version: "v2" }] as never);
    db.providerPricingVersion.create.mockResolvedValue({
      id: "pv-3",
      providerModelId: "pm-1",
      version: "v3",
      status: "DRAFT",
      currency: "USD",
      confidence: "CALCULATED",
      pricing: { ratesPerMillion: { input: "0.5", output: "1.5" } },
      effectiveAt: new Date("2026-10-01T00:00:00Z"),
      activatedAt: null,
      retiredAt: null,
    } as never);
    const view = await client().pricing.create({
      modelId: "pm-1",
      currency: "USD",
      pricing: { input: "0.5", output: "1.5" },
    });
    expect(db.providerPricingVersion.create.mock.calls[0]?.[0]?.data).toMatchObject({
      version: "v3",
      pricing: { ratesPerMillion: { input: "0.5", output: "1.5" } },
      chargeRules: expect.objectContaining({ unknownCategories: "FAIL_CLOSED" }),
    });
    expect(view.pricing).toEqual({ input: "0.5", output: "1.5" });
  });

  it("a future price retires the current one only when it starts", async () => {
    const start = new Date(Date.now() + 86_400_000);
    db.providerPricingVersion.findFirst.mockResolvedValue({
      id: "pv-2",
      providerModelId: "pm-1",
      effectiveAt: start,
    } as never);
    db.providerPricingVersion.update.mockResolvedValue({
      id: "pv-2",
      providerModelId: "pm-1",
      version: "v2",
      status: "ACTIVE",
      currency: "USD",
      confidence: "CALCULATED",
      pricing: {},
      effectiveAt: start,
      activatedAt: new Date(),
      retiredAt: null,
    } as never);
    await client().pricing.activate({ versionId: "pv-2" });
    expect(db.providerPricingVersion.updateMany.mock.calls[0]?.[0]?.data).toEqual({
      status: "RETIRED",
      retiredAt: start,
    });
    expect(fenceLog.held).toEqual(["00:owner:owner-1", "05:provider-pricing:owner-1:pm-1"]);
  });

  it("a duplicate label on rename is a conflict, not a crash", async () => {
    db.providerAccount.findFirst.mockResolvedValue({
      id: "acc-1",
      baseUrl: "https://openrouter.ai/api/v1",
      endpointVersion: 1,
    } as never);
    db.$transaction.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect(await codeOf(client().accounts.update({ accountId: "acc-1", label: "Taken" }))).toBe(
      "CONFLICT",
    );
  });

  it("a base URL change bumps the endpoint version read under the fence", async () => {
    db.providerAccount.findFirst.mockResolvedValueOnce({
      id: "acc-1",
      baseUrl: "https://a.example.com/v1",
      endpointVersion: 1,
    } as never);
    db.providerAccount.findFirst.mockResolvedValue(accountRow() as never);
    db.providerAccount.findUniqueOrThrow.mockResolvedValue({
      baseUrl: "https://a.example.com/v1",
      endpointVersion: 4,
    } as never);
    await client().accounts.update({ accountId: "acc-1", baseUrl: "https://b.example.com/v1" });
    expect(db.providerAccount.update.mock.calls[0]?.[0]?.data).toEqual({
      baseUrl: "https://b.example.com/v1",
      endpointIdentity: "https://b.example.com/v1",
      endpointVersion: 5,
    });
  });

  it("re-adding a deleted model restores its row", async () => {
    db.providerAccount.findFirst.mockResolvedValue(accountRow() as never);
    db.providerModel.findFirst.mockResolvedValue({ id: "pm-old", type: "LLM" } as never);
    db.providerModel.findUniqueOrThrow.mockResolvedValue({
      id: "pm-old",
      providerAccountId: "acc-1",
      upstreamModelId: "m",
      displayName: null,
      type: "LLM",
      enabled: false,
      health: "UNKNOWN",
      contextWindow: null,
      maxOutputTokens: null,
      PricingVersions: [],
    } as never);
    const view = await client().models.create({
      accountId: "acc-1",
      upstreamModelId: "m",
      type: "LLM",
    });
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.providerModel.update.mock.calls[0]?.[0]?.data).toMatchObject({ deletedAt: null });
    expect(view.id).toBe("pm-old");
  });

  it("another person's key, model and price are not found", async () => {
    db.providerCredential.findFirst.mockResolvedValue(null);
    db.providerModel.findFirst.mockResolvedValue(null);
    db.providerPricingVersion.findFirst.mockResolvedValue(null);
    expect(await codeOf(client().credentials.revoke({ credentialId: "c-x" }))).toBe("NOT_FOUND");
    expect(await codeOf(client().models.delete({ modelId: "m-x" }))).toBe("NOT_FOUND");
    expect(await codeOf(client().pricing.activate({ versionId: "v-x" }))).toBe("NOT_FOUND");
    expect(db.providerCredential.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "c-x",
      userId: OWNER,
    });
    expect(db.providerModel.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({ userId: OWNER });
    expect(db.providerPricingVersion.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: OWNER,
    });
  });
});
