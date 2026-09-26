import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { catalogEntry, liveShapedCatalogEntries } from "../lib/fixtures/openrouter-catalog";

const envMock = vi.hoisted(() => ({ enabled: true }));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return envMock.enabled;
    },
    WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep(), Prisma: { JsonNull: "JsonNull" } };
});

const { createProviderCatalogRouter } = await import("./provider-catalog");
const { CATALOG_CHARGE_RULES, catalogNativeCapabilities, parseCatalog } = await import(
  "../lib/provider-catalog-model"
);
const { default: prisma } = await import("@ws-model-proxy/db");
type ProviderCatalogResult = Awaited<
  ReturnType<import("../lib/provider-catalog").ProviderCatalog["get"]>
>;

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  providerAccount: { findFirst: MockInstance };
  providerModel: {
    findFirst: MockInstance;
    create: MockInstance;
    update: MockInstance;
    updateMany: MockInstance;
  };
  providerPricingVersion: {
    findMany: MockInstance;
    updateMany: MockInstance;
    create: MockInstance;
  };
  providerAuditEvent: { create: MockInstance; findMany: MockInstance };
  executionTarget: { create: MockInstance; findUnique: MockInstance };
  modelPool: { findFirst: MockInstance; updateMany: MockInstance };
};

function session(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      emailVerified: true,
      role: "user",
      twoFactorEnabled: false,
      image: null,
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    session: {
      id: `s-${userId}`,
      userId,
      token: "token",
      expiresAt: new Date(Date.now() + 60_000),
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as Session;
}
const context: Context = { session: session("owner") };

const models = parseCatalog({
  data: [
    catalogEntry(),
    catalogEntry({
      id: "vendor/no-tools",
      name: "No Tools",
      supported_parameters: [],
      context_length: 8_000,
    }),
    catalogEntry({
      id: "vendor/image-only",
      name: "Image Only",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    }),
    catalogEntry({
      id: "openrouter/auto",
      name: "Auto",
      pricing: { prompt: "-1", completion: "-1" },
    }),
  ],
});
const fetchedAt = new Date("2026-09-26T12:00:00Z");
let catalogResult: ProviderCatalogResult;
const catalog = { get: vi.fn(async () => catalogResult), reset: vi.fn() };

function client(ctx: Context = context) {
  return createRouterClient(createProviderCatalogRouter(catalog), { context: ctx });
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.enabled = true;
  catalogResult = { status: "ok", models, fetchedAt, stale: false };
  db.$transaction.mockImplementation(async (callback: (tx: typeof db) => unknown) => callback(db));
});

describe("providerCatalog.search", () => {
  it("requires a signed-in user", async () => {
    await expect(client({ session: null }).search({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("returns a stable disabled reason and makes no pool lookup or fetch when the switch is off", async () => {
    envMock.enabled = false;
    const expected = {
      status: "disabled",
      reason: "EXTERNAL_PROVIDERS_DISABLED",
      items: [],
      nextCursor: null,
      total: 0,
    };
    await expect(client().search({ query: "qwen" })).resolves.toEqual(expected);
    await expect(client().search({ poolId: "someone-elses-pool" })).resolves.toEqual(expected);
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.modelPool.findFirst).not.toHaveBeenCalled();
  });

  it("returns trimmed rows with pool-independent verdicts and pages with a cursor", async () => {
    const first = await client().search({ limit: 2 });
    expect(first).toMatchObject({ status: "ok", stale: false, total: 4, nextCursor: 2 });
    expect(first.items[0]).toEqual({
      id: "qwen/qwen3-coder",
      name: "Qwen: Qwen3 Coder",
      contextLength: 262_144,
      maxCompletionTokens: 65_536,
      pricing: {
        prompt: "0.0000002",
        completion: "0.0000008",
        cacheRead: "0.00000002",
        cacheWrite: null,
        variable: false,
        tiered: false,
      },
      supportsTools: true,
      supportsReasoning: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
      expirationDate: null,
      moderated: false,
      free: false,
      compatibility: { verdict: "ok", block: [], warn: [] },
    });
    const second = await client().search({ limit: 2, cursor: 2 });
    expect(second.items.map((row) => row.id)).toEqual(["vendor/image-only", "openrouter/auto"]);
    expect(second.items[0]?.compatibility.verdict).toBe("block");
    expect(second.items[1]?.compatibility.warn).toEqual(["UNKNOWN_PRICE"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by query and capabilities", async () => {
    const result = await client().search({ query: "vendor", filters: { tools: true } });
    expect(result.items.map((row) => row.id)).toEqual(["vendor/image-only"]);
  });

  it("rejects a limit above 50", async () => {
    await expect(client().search({ limit: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("computes verdicts against a pool the caller can see (owner or grantee)", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      capacityContextCeiling: null,
      PoolMembers: [
        {
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: null,
            ProviderModel: {
              contextWindow: 131_072,
              nativeCapabilities: {
                version: 4,
                protocol: "openai-compatible",
                surfaces: {
                  openaiChatCompletions: {
                    source: "dashboard",
                    confidence: "exact",
                    operations: ["create"],
                    tools: true,
                  },
                },
              },
            },
            InferenceCapacity: null,
          },
        },
      ],
    });
    const result = await client(context).search({ poolId: "pool-1", query: "no-tools" });
    expect(result.items[0]?.compatibility).toEqual({
      verdict: "warn",
      block: [],
      warn: ["NO_TOOLS", "SMALLER_CONTEXT"],
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "pool-1",
          OR: [{ userId: "owner" }, { PoolGrants: { some: { granteeUserId: "owner" } } }],
        },
      }),
    );
  });

  it("answers NOT_FOUND identically for a missing or invisible pool, before any fetch", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    const error = await client(context)
      .search({ poolId: "pool-x" })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "NOT_FOUND", message: "Not found" });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("reports an unavailable catalog without throwing", async () => {
    catalogResult = { status: "unavailable", reason: "CATALOG_UNAVAILABLE" };
    await expect(client().search({})).resolves.toMatchObject({
      status: "unavailable",
      reason: "CATALOG_UNAVAILABLE",
      items: [],
    });
  });

  it("marks stale results", async () => {
    catalogResult = { status: "ok", models, fetchedAt, stale: true };
    await expect(client().search({})).resolves.toMatchObject({ status: "ok", stale: true });
  });
});

describe("providerCatalog.importModel", () => {
  const account = { id: "acct-1", providerType: "openrouter" };
  const qwenCapabilities = () => {
    const qwen = models.find((model) => model.id === "qwen/qwen3-coder");
    if (!qwen) throw new Error("fixture");
    return catalogNativeCapabilities(qwen);
  };
  const catalogRates = {
    input: "0.2",
    output: "0.8",
    cacheRead: "0.02",
    cacheWrite: "0.2",
    reasoning: "0.8",
  };
  type ActiveRow = {
    id: string;
    version: string;
    currency: string;
    accountingVersion: string;
    pricing: unknown;
    chargeRules: unknown;
    effectiveAt: Date;
  };
  type Stored = {
    deletedAt: Date | null;
    displayName: string | null;
    nativeCapabilities: unknown;
    contextWindow: number | null;
    maxOutputTokens: number | null;
  };
  // In-memory view of what the transaction reads, plus an ordered lock log.
  let stored: Stored | null;
  let hasTarget: boolean;
  let active: ActiveRow[];
  let catalogAuthored: Set<string>;
  let locks: string[];

  const activeRow = (overrides: Partial<ActiveRow> = {}): ActiveRow => ({
    id: "price-0",
    version: "v0",
    currency: "USD",
    accountingVersion: "provider-billable-v1",
    pricing: { ratesPerMillion: { input: "1", output: "2" } },
    chargeRules: {},
    effectiveAt: new Date(Date.now() - 60_000),
    ...overrides,
  });
  const storedModel = (overrides: Partial<Stored> = {}): Stored => ({
    deletedAt: null,
    displayName: "Qwen: Qwen3 Coder",
    nativeCapabilities: qwenCapabilities(),
    contextWindow: 262_144,
    maxOutputTokens: 65_536,
    ...overrides,
  });
  const sql = (strings: TemplateStringsArray, values: unknown[]) =>
    strings.reduce(
      (text, part, index) => `${text}${part}${index < values.length ? `$${index}` : ""}`,
      "",
    );

  beforeEach(() => {
    stored = null;
    hasTarget = true;
    active = [];
    catalogAuthored = new Set();
    locks = [];
    db.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push(`advisory ${String(values[0])}`);
        return sql(strings, values) && 1;
      },
    );
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings, values);
      locks.push(text.includes("provider_account") ? "provider_account" : "provider_model");
      return [];
    });
    db.providerAccount.findFirst.mockResolvedValue(account);
    db.providerModel.findFirst.mockImplementation(
      async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        if (!stored) return null;
        if (args.select && "deletedAt" in args.select) return stored;
        if (args.select && "upstreamModelId" in args.select)
          return {
            id: "pm-1",
            providerAccountId: "acct-1",
            upstreamModelId: "qwen/qwen3-coder",
            displayName: stored.displayName,
            contextWindow: stored.contextWindow,
            maxOutputTokens: stored.maxOutputTokens,
            pricingVersion: null,
            enabled: false,
          };
        return { id: "pm-1" };
      },
    );
    db.providerModel.create.mockImplementation(async (args: { data: Stored }) => {
      stored = { ...args.data, deletedAt: null };
      return { id: "pm-1" };
    });
    db.executionTarget.findUnique.mockImplementation(async () =>
      hasTarget ? { id: "et-1" } : null,
    );
    db.providerPricingVersion.findMany.mockImplementation(async () => active);
    db.providerAuditEvent.findMany.mockImplementation(
      async (args: { where: { subjectId: { in: string[] } } }) =>
        args.where.subjectId.in
          .filter((subjectId) => catalogAuthored.has(subjectId))
          .map((subjectId) => ({ subjectId })),
    );
    db.providerPricingVersion.create.mockImplementation(
      async (args: { data: { version: string } }) => ({
        id: "price-1",
        version: args.data.version,
      }),
    );
  });

  const importQwen = (modelId = "qwen/qwen3-coder") =>
    client().importModel({ providerAccountId: "acct-1", modelId });
  const auditActions = () =>
    db.providerAuditEvent.create.mock.calls.map(
      ([args]: [{ data: { action: string; subjectId: string; metadata: unknown } }]) => [
        args.data.action,
        args.data.subjectId,
        args.data.metadata,
      ],
    );

  it("is hidden when the switch is off", async () => {
    envMock.enabled = false;
    await expect(importQwen()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("cannot import into another user's account, and no fetch happens", async () => {
    db.providerAccount.findFirst.mockResolvedValue(null);
    await expect(
      client(context).importModel({
        providerAccountId: "someone-else",
        modelId: "qwen/qwen3-coder",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.providerAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-else", userId: "owner", deletedAt: null } }),
    );
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });

  it("creates the model, its execution target, audit events and an ACTIVE catalog price", async () => {
    const result = await importQwen();
    expect(result).toMatchObject({
      created: true,
      restored: false,
      pricing: "created",
      priceTiered: false,
      contextWindowDrift: null,
      compatibility: { verdict: "ok" },
    });
    // A new model's id is not visible to others: no identity fence needed.
    expect(locks[0]).toBe("provider_account");
    expect(db.providerModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        providerAccountId: "acct-1",
        upstreamModelId: "qwen/qwen3-coder",
        displayName: "Qwen: Qwen3 Coder",
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        enabled: false,
        nativeCapabilities: expect.objectContaining({
          version: 4,
          surfaces: { openaiChatCompletions: expect.objectContaining({ tools: true }) },
        }),
      }),
      select: { id: true },
    });
    expect(db.executionTarget.create).toHaveBeenCalledWith({
      data: { userId: "owner", kind: "PROVIDER_MODEL", providerModelId: "pm-1" },
    });
    expect(db.providerPricingVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "owner",
        providerAccountId: "acct-1",
        providerModelId: "pm-1",
        currency: "USD",
        status: "ACTIVE",
        confidence: "ESTIMATED",
        pricing: { ratesPerMillion: catalogRates },
        chargeRules: expect.objectContaining({ unknownCategories: "FAIL_CLOSED" }),
      }),
      select: { id: true, version: true },
    });
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pm-1" },
        data: expect.objectContaining({ pricingVersion: expect.stringMatching(/^openrouter-/u) }),
      }),
    );
    expect(auditActions()).toEqual([
      [
        "MODEL_CREATED",
        "pm-1",
        { source: "OPENROUTER_CATALOG", catalogModelId: "qwen/qwen3-coder" },
      ],
      [
        "PRICING_ACTIVATED",
        "price-1",
        expect.objectContaining({
          source: "OPENROUTER_CATALOG",
          catalogModelId: "qwen/qwen3-coder",
        }),
      ],
    ]);
  });

  it("takes the provider-model identity fence before the account row when the model exists", async () => {
    stored = storedModel();
    hasTarget = false;
    await importQwen();
    expect(locks.slice(0, 2)).toEqual([
      "advisory execution-target:provider-model:pm-1",
      "provider_account",
    ]);
    // ...and only then the pricing lock and the model row.
    expect(locks.slice(2, 4)).toEqual(["advisory provider-pricing:owner:pm-1", "provider_model"]);
    expect(db.executionTarget.create).toHaveBeenCalledWith({
      data: { userId: "owner", kind: "PROVIDER_MODEL", providerModelId: "pm-1" },
    });
  });

  it("is idempotent: re-importing identical catalog data writes nothing", async () => {
    // Postgres jsonb reorders keys; the comparison must not depend on order.
    const reversed = (value: object) =>
      JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value).reverse())));
    stored = storedModel({ nativeCapabilities: reversed(qwenCapabilities()) });
    active = [
      activeRow({
        id: "price-1",
        pricing: { ratesPerMillion: reversed(catalogRates) },
        chargeRules: reversed(CATALOG_CHARGE_RULES),
      }),
    ];
    catalogAuthored = new Set(["price-1"]);
    const again = await importQwen();
    expect(again).toMatchObject({ created: false, restored: false, pricing: "unchanged" });
    expect(db.providerModel.create).not.toHaveBeenCalled();
    expect(db.providerModel.update).not.toHaveBeenCalled();
    expect(db.executionTarget.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
    expect(db.providerAuditEvent.create).not.toHaveBeenCalled();
  });

  it("replaces a catalog-authored ACTIVE price when the catalog price changed", async () => {
    stored = storedModel({ contextWindow: 131_072 });
    hasTarget = false;
    active = [activeRow()];
    catalogAuthored = new Set(["price-0"]);
    const result = await importQwen();
    expect(result).toMatchObject({
      created: false,
      pricing: "updated",
      // Context feeds capacity policy: reported, never silently rewritten.
      contextWindowDrift: { current: 131_072, catalog: 262_144 },
    });
    expect(db.providerAuditEvent.findMany).toHaveBeenCalledWith({
      where: {
        userId: "owner",
        action: "PRICING_ACTIVATED",
        subjectId: { in: ["price-0"] },
        metadata: { path: ["source"], equals: "OPENROUTER_CATALOG" },
      },
      select: { subjectId: true },
    });
    expect(db.providerPricingVersion.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "owner",
        providerModelId: "pm-1",
        status: "ACTIVE",
        id: { in: ["price-0"] },
      },
      data: { status: "RETIRED", retiredAt: expect.any(Date) },
    });
    expect(db.providerPricingVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pricing: { ratesPerMillion: catalogRates } }),
      }),
    );
    expect(auditActions().map(([action, subject]) => [action, subject])).toEqual([
      ["PRICING_RETIRED", "price-0"],
      ["PRICING_ACTIVATED", "price-1"],
    ]);
    // Nothing else about the model changed, so it is not rewritten.
    expect(db.providerModel.update).toHaveBeenCalledTimes(1);
    expect(db.providerModel.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pricingVersion: expect.any(String) }),
      }),
    );
    // A missing execution target (and so capacity) is created for the runtime.
    expect(db.executionTarget.create).toHaveBeenCalledWith({
      data: { userId: "owner", kind: "PROVIDER_MODEL", providerModelId: "pm-1" },
    });
  });

  it("keeps a user-authored ACTIVE price and says so", async () => {
    stored = storedModel();
    active = [activeRow({ id: "mine", version: "my-price" })];
    const result = await importQwen();
    expect(result.pricing).toBe("userPricingKept");
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerModel.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a user-authored price even when the catalog price becomes unknown", async () => {
    stored = storedModel();
    active = [activeRow({ id: "mine" })];
    const result = await importQwen("openrouter/auto");
    expect(result.pricing).toBe("userPricingKept");
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
  });

  it("retires a catalog-authored price when the catalog price becomes unknown", async () => {
    stored = storedModel();
    active = [activeRow({ id: "price-0", version: "openrouter-old" })];
    catalogAuthored = new Set(["price-0"]);
    const result = await importQwen("openrouter/auto");
    expect(result.pricing).toBe("catalogPricingRetired");
    expect(db.providerPricingVersion.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "owner",
        providerModelId: "pm-1",
        status: "ACTIVE",
        id: { in: ["price-0"] },
      },
      data: { status: "RETIRED", retiredAt: expect.any(Date) },
    });
    // The model points at no price, so SPEND rules fail closed.
    expect(db.providerModel.updateMany).toHaveBeenCalledWith({
      where: { id: "pm-1", userId: "owner", pricingVersion: { in: ["openrouter-old"] } },
      data: { pricingVersion: null, pricingMetadata: "JsonNull" },
    });
    expect(auditActions()).toContainEqual([
      "PRICING_RETIRED",
      "price-0",
      {
        version: "openrouter-old",
        source: "OPENROUTER_CATALOG",
        catalogModelId: "openrouter/auto",
      },
    ]);
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
  });

  it("reports unknown only when no ACTIVE price exists", async () => {
    const result = await importQwen("openrouter/auto");
    expect(result.pricing).toBe("unknown");
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
  });

  it("never overrides a future-dated ACTIVE price the user scheduled", async () => {
    active = [activeRow({ id: "future", effectiveAt: new Date(Date.now() + 86_400_000) })];
    const result = await importQwen();
    expect(result.pricing).toBe("scheduledPricingExists");
    expect(db.providerPricingVersion.create).not.toHaveBeenCalled();
    expect(db.providerPricingVersion.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the owner's display name and does not clear max output when the catalog has none", async () => {
    stored = storedModel({
      displayName: "My renamed Qwen",
      maxOutputTokens: 4_096,
      nativeCapabilities: null,
    });
    catalogResult = {
      status: "ok",
      models: parseCatalog({
        data: [catalogEntry({ top_provider: { context_length: 262_144 } })],
      }),
      fetchedAt,
      stale: false,
    };
    await importQwen();
    // Only the catalog-owned capability inventory is rewritten.
    expect(db.providerModel.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { nativeCapabilities: expect.objectContaining({ version: 4 }) },
    });
    const updates = db.providerModel.update.mock.calls.map(
      ([args]: [{ data: object }]) => args.data,
    );
    for (const data of updates) {
      expect(data).not.toHaveProperty("displayName");
      expect(data).not.toHaveProperty("maxOutputTokens");
    }
  });

  it("refreshes max output and capabilities from the catalog", async () => {
    stored = storedModel({ displayName: "Mine", maxOutputTokens: 4_096, nativeCapabilities: null });
    active = [
      activeRow({
        id: "price-1",
        pricing: { ratesPerMillion: catalogRates },
        chargeRules: CATALOG_CHARGE_RULES,
      }),
    ];
    catalogAuthored = new Set(["price-1"]);
    await importQwen();
    expect(db.providerModel.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { nativeCapabilities: qwenCapabilities(), maxOutputTokens: 65_536 },
    });
  });

  it("restores a soft-deleted model disabled, keeping its name", async () => {
    stored = storedModel({ deletedAt: new Date(), displayName: "Mine" });
    const result = await importQwen();
    expect(result.restored).toBe(true);
    expect(locks[0]).toBe("advisory execution-target:provider-model:pm-1");
    expect(db.providerModel.update).toHaveBeenCalledWith({
      where: { id: "pm-1" },
      data: { deletedAt: null, enabled: false },
    });
  });

  it("imports a floating `~` alias with its tier upper bound", async () => {
    catalogResult = {
      status: "ok",
      models: parseCatalog({ data: liveShapedCatalogEntries() }),
      fetchedAt,
      stale: false,
    };
    const result = await importQwen("~openai/gpt-luna-latest");
    expect(result).toMatchObject({ created: true, pricing: "created", priceTiered: true });
    expect(db.providerModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ upstreamModelId: "~openai/gpt-luna-latest" }),
      }),
    );
    expect(db.providerPricingVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pricing: {
            ratesPerMillion: {
              input: "0.2",
              output: "0.75",
              cacheRead: "0.02",
              cacheWrite: "0.25",
              reasoning: "0.75",
            },
          },
        }),
      }),
    );
  });

  it("rejects a blocked model, an unknown model, and a non-OpenRouter account", async () => {
    await expect(importQwen("vendor/image-only")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CATALOG_MODEL_INCOMPATIBLE" },
    });
    await expect(importQwen("vendor/missing")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CATALOG_MODEL_NOT_FOUND" },
    });
    db.providerAccount.findFirst.mockResolvedValue({ id: "acct-1", providerType: "openai" });
    await expect(importQwen()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "CATALOG_ACCOUNT_NOT_OPENROUTER" },
    });
    expect(db.providerModel.create).not.toHaveBeenCalled();
  });

  it("fails with SERVICE_UNAVAILABLE when the catalog cannot be fetched", async () => {
    catalogResult = { status: "unavailable", reason: "CATALOG_UNAVAILABLE" };
    await expect(importQwen()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      data: { reason: "CATALOG_UNAVAILABLE" },
    });
  });
});

describe("providerCatalog pool external equivalent", () => {
  it("reads only the caller's own pool", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(client().getPoolExternalEquivalent({ poolId: "p" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p", userId: "owner" } }),
    );
    db.modelPool.findFirst.mockResolvedValue({ externalEquivalentModel: "qwen/qwen3-coder" });
    envMock.enabled = false;
    await expect(client().getPoolExternalEquivalent({ poolId: "p" })).resolves.toEqual({
      externalEquivalentModel: "qwen/qwen3-coder",
      providerEgressEnabled: false,
    });
  });

  it("rejects a grantee or stranger before any fetch", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(
      client({ session: session("grantee") }).setPoolExternalEquivalent({
        poolId: "p",
        modelId: "qwen/qwen3-coder",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(catalog.get).not.toHaveBeenCalled();
    expect(db.modelPool.updateMany).not.toHaveBeenCalled();
  });

  it("sets a catalog model with pool verdicts", async () => {
    db.modelPool.findFirst
      .mockResolvedValueOnce({ id: "p" })
      .mockResolvedValueOnce({ capacityContextCeiling: 100_000, PoolMembers: [] });
    db.modelPool.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/no-tools" }),
    ).resolves.toEqual({
      externalEquivalentModel: "vendor/no-tools",
      compatibility: { verdict: "warn", block: [], warn: ["SMALLER_CONTEXT"] },
    });
    expect(db.modelPool.updateMany).toHaveBeenCalledWith({
      where: { id: "p", userId: "owner" },
      data: { externalEquivalentModel: "vendor/no-tools" },
    });
  });

  it("accepts a floating `~` alias as the equivalent", async () => {
    catalogResult = {
      status: "ok",
      models: parseCatalog({ data: liveShapedCatalogEntries() }),
      fetchedAt,
      stale: false,
    };
    db.modelPool.findFirst
      .mockResolvedValueOnce({ id: "p" })
      .mockResolvedValueOnce({ capacityContextCeiling: null, PoolMembers: [] });
    db.modelPool.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "~openai/gpt-luna-latest" }),
    ).resolves.toMatchObject({ externalEquivalentModel: "~openai/gpt-luna-latest" });
    expect(db.modelPool.updateMany).toHaveBeenCalledWith({
      where: { id: "p", userId: "owner" },
      data: { externalEquivalentModel: "~openai/gpt-luna-latest" },
    });
  });

  it("always allows clearing, even with the switch off, without a fetch", async () => {
    envMock.enabled = false;
    db.modelPool.findFirst.mockResolvedValue({ id: "p" });
    db.modelPool.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: null }),
    ).resolves.toEqual({ externalEquivalentModel: null, compatibility: null });
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it("refuses to set a model when disabled, missing, blocked or malformed", async () => {
    db.modelPool.findFirst.mockResolvedValue({ id: "p" });
    catalogResult = { status: "disabled", reason: "EXTERNAL_PROVIDERS_DISABLED" };
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "qwen/qwen3-coder" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { reason: "EXTERNAL_PROVIDERS_DISABLED" },
    });
    catalogResult = { status: "ok", models, fetchedAt, stale: false };
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/missing" }),
    ).rejects.toMatchObject({ data: { reason: "CATALOG_MODEL_NOT_FOUND" } });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "vendor/image-only" }),
    ).rejects.toMatchObject({ data: { reason: "CATALOG_MODEL_INCOMPATIBLE" } });
    await expect(
      client().setPoolExternalEquivalent({ poolId: "p", modelId: "not a slug" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.modelPool.updateMany).not.toHaveBeenCalled();
  });
});
