import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "../context";
import { catalogEntry } from "../lib/fixtures/openrouter-catalog";

// importModel is the first path that INSERTs a pricing row directly as ACTIVE
// (activatePricingVersion goes DRAFT -> ACTIVE). This proves it against the
// real schema: the pricing shape CHECK and immutability trigger, the provider
// graph triggers, and the execution-target capacity trigger.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

type CatalogResult = Awaited<ReturnType<import("../lib/provider-catalog").ProviderCatalog["get"]>>;

integration("providerCatalog.importModel with real PostgreSQL", () => {
  let modules:
    | {
        prisma: typeof import("@ws-model-proxy/db").default;
        router: typeof import("./provider-catalog");
        parseCatalog: typeof import("../lib/provider-catalog-model").parseCatalog;
      }
    | undefined;
  // The catalog is injected: no outbound request is made.
  let catalogResult: CatalogResult = { status: "unavailable", reason: "CATALOG_UNAVAILABLE" };
  const catalog = { get: async () => catalogResult, reset: () => undefined };

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    const [db, router, model] = await Promise.all([
      import("@ws-model-proxy/db"),
      import("./provider-catalog"),
      import("../lib/provider-catalog-model"),
    ]);
    modules = { prisma: db.default, router, parseCatalog: model.parseCatalog };
  });

  afterAll(() => {
    // Imports write append-only provider audit and pricing history. Unique
    // fixture identities keep retained rows isolated in shared CI.
  });

  function useCatalog(entries: unknown[]) {
    if (!modules) throw new Error("modules unavailable");
    catalogResult = {
      status: "ok",
      models: modules.parseCatalog({ data: entries }),
      fetchedAt: new Date(),
      stale: false,
    };
  }

  async function fixture() {
    if (!modules) throw new Error("modules unavailable");
    const suffix = crypto.randomUUID();
    const user = await modules.prisma.user.create({
      data: {
        name: "Catalog import integration",
        email: `catalog-import-${suffix}@example.test`,
        slug: `catalog-import-${suffix}`,
      },
    });
    const account = await modules.prisma.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "openrouter",
        label: `openrouter-${suffix}`,
        baseUrl: "https://openrouter.ai/api",
        endpointIdentity: "https://openrouter.ai/api",
        authType: "BEARER",
        status: "ACTIVE",
        enabled: false,
      },
    });
    const session = {
      user,
      session: {
        id: `session-${suffix}`,
        userId: user.id,
        token: `token-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "integration",
      },
    } as Session;
    const client = createRouterClient(modules.router.createProviderCatalogRouter(catalog), {
      context: { session } satisfies Context,
    });
    return { prisma: modules.prisma, user, account, client };
  }

  const activePrices = (
    prisma: typeof import("@ws-model-proxy/db").default,
    providerModelId: string,
  ) =>
    prisma.providerPricingVersion.findMany({
      where: { providerModelId, status: "ACTIVE" },
      select: { id: true, version: true, pricing: true },
    });

  // Distinct millisecond timestamps for consecutive pricing versions.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("imports a new model with its target, capacity and an ACTIVE catalog price", async () => {
    const { prisma, user, account, client } = await fixture();
    useCatalog([catalogEntry()]);
    const result = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(result).toMatchObject({ created: true, pricing: "created" });
    const model = await prisma.providerModel.findUniqueOrThrow({
      where: { id: result.model.id },
      select: { userId: true, enabled: true, pricingVersion: true, contextWindow: true },
    });
    expect(model).toMatchObject({ userId: user.id, enabled: false, contextWindow: 262_144 });
    const target = await prisma.executionTarget.findUniqueOrThrow({
      where: { providerModelId: result.model.id },
      select: { kind: true, inferenceCapacityId: true },
    });
    expect(target.kind).toBe("PROVIDER_MODEL");
    expect(target.inferenceCapacityId).not.toBeNull();
    const [price, ...others] = await activePrices(prisma, result.model.id);
    expect(others).toEqual([]);
    expect(price?.version).toBe(model.pricingVersion);
    expect(price?.pricing).toEqual({
      ratesPerMillion: {
        input: "0.2",
        output: "0.8",
        cacheRead: "0.02",
        cacheWrite: "0.2",
        reasoning: "0.8",
      },
    });
    // The provenance record the re-import relies on.
    const audit = await prisma.providerAuditEvent.findFirstOrThrow({
      where: { userId: user.id, action: "PRICING_ACTIVATED", subjectId: price?.id },
      select: { metadata: true },
    });
    expect(audit.metadata).toMatchObject({ source: "OPENROUTER_CATALOG" });
  });

  it("replaces a changed catalog price, then retires it when the price becomes variable", async () => {
    const { prisma, account, client } = await fixture();
    useCatalog([catalogEntry()]);
    const first = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    const [original] = await activePrices(prisma, first.model.id);
    await tick();
    useCatalog([catalogEntry({ pricing: { prompt: "0.0000004", completion: "0.0000016" } })]);
    const changed = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(changed.pricing).toBe("updated");
    const retired = await prisma.providerPricingVersion.findUniqueOrThrow({
      where: { id: original?.id },
      select: { status: true, retiredAt: true, effectiveAt: true },
    });
    expect(retired.status).toBe("RETIRED");
    expect(retired.retiredAt?.getTime()).toBeGreaterThan(retired.effectiveAt.getTime());
    const [current, ...others] = await activePrices(prisma, first.model.id);
    expect(others).toEqual([]);
    expect(current?.pricing).toMatchObject({ ratesPerMillion: { input: "0.4", output: "1.6" } });
    await tick();
    useCatalog([catalogEntry({ pricing: { prompt: "-1", completion: "-1" } })]);
    const variable = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(variable.pricing).toBe("catalogPricingRetired");
    expect(await activePrices(prisma, first.model.id)).toEqual([]);
    const model = await prisma.providerModel.findUniqueOrThrow({
      where: { id: first.model.id },
      select: { pricingVersion: true },
    });
    expect(model.pricingVersion).toBeNull();
  });

  it("keeps a user-authored ACTIVE price and the owner's display name", async () => {
    const { prisma, user, account, client } = await fixture();
    const model = await prisma.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: "qwen/qwen3-coder",
        displayName: "My Qwen",
        maxOutputTokens: 4_096,
      },
    });
    const mine = await prisma.providerPricingVersion.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        providerModelId: model.id,
        version: "my-price",
        currency: "USD",
        pricing: { ratesPerMillion: { input: "9", output: "9" } },
        chargeRules: { unknownCategories: "FAIL_CLOSED" },
        effectiveAt: new Date(Date.now() - 60_000),
      },
    });
    useCatalog([catalogEntry({ top_provider: { context_length: 262_144 } })]);
    const result = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(result).toMatchObject({ created: false, pricing: "userPricingKept" });
    expect((await activePrices(prisma, model.id)).map((row) => row.id)).toEqual([mine.id]);
    const after = await prisma.providerModel.findUniqueOrThrow({
      where: { id: model.id },
      select: { displayName: true, maxOutputTokens: true },
    });
    expect(after).toEqual({ displayName: "My Qwen", maxOutputTokens: 4_096 });
  });

  it("backfills the execution target of a model created without one", async () => {
    const { prisma, user, account, client } = await fixture();
    const model = await prisma.providerModel.create({
      data: {
        userId: user.id,
        providerAccountId: account.id,
        upstreamModelId: "qwen/qwen3-coder",
      },
    });
    expect(
      await prisma.executionTarget.findUnique({ where: { providerModelId: model.id } }),
    ).toBeNull();
    useCatalog([catalogEntry()]);
    const result = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(result).toMatchObject({ created: false, pricing: "created" });
    const target = await prisma.executionTarget.findUniqueOrThrow({
      where: { providerModelId: model.id },
      select: { inferenceCapacityId: true },
    });
    expect(target.inferenceCapacityId).not.toBeNull();
  });

  it("restores a soft-deleted model disabled", async () => {
    const { prisma, account, client } = await fixture();
    useCatalog([catalogEntry()]);
    const first = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    await prisma.providerModel.update({
      where: { id: first.model.id },
      data: { deletedAt: new Date(), enabled: false },
    });
    const restored = await client.importModel({
      providerAccountId: account.id,
      modelId: "qwen/qwen3-coder",
    });
    expect(restored).toMatchObject({ created: false, restored: true, pricing: "unchanged" });
    const model = await prisma.providerModel.findUniqueOrThrow({
      where: { id: first.model.id },
      select: { deletedAt: true, enabled: true },
    });
    expect(model).toEqual({ deletedAt: null, enabled: false });
  });
});
