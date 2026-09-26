import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { loadPoolCatalogProfile } from "../lib/catalog-pool-profile";
import {
  createProviderCatalog,
  fetchOpenRouterCatalogJson,
  type ProviderCatalog,
} from "../lib/provider-catalog";
import {
  CATALOG_CHARGE_RULES,
  CATALOG_MAX_MODELS,
  CATALOG_SEARCH_MAX_LIMIT,
  type CatalogModel,
  type CatalogRatesPerMillion,
  catalogCompatibility,
  catalogModelIdSchema,
  catalogNativeCapabilities,
  catalogRatesPerMillion,
  type PoolCatalogProfile,
  searchCatalog,
  stableJson,
} from "../lib/provider-catalog-model";
import { runSerializableTransaction } from "../lib/serializable-transaction";

/**
 * OpenRouter public catalog: search, "import from catalog", and the pool
 * owner's external-equivalent declaration. Human-only (browser session): every
 * procedure is excluded from MCP (see MCP_TOOL_EXCLUSIONS).
 */

const OPENROUTER_PROVIDER_TYPE = "openrouter";
const CATALOG_SOURCE = "OPENROUTER_CATALOG";
const CATALOG_ACCOUNTING_VERSION = "provider-billable-v1";

export const providerCatalogReasons = {
  disabled: "EXTERNAL_PROVIDERS_DISABLED",
  unavailable: "CATALOG_UNAVAILABLE",
  modelNotFound: "CATALOG_MODEL_NOT_FOUND",
  incompatible: "CATALOG_MODEL_INCOMPATIBLE",
  notOpenRouter: "CATALOG_ACCOUNT_NOT_OPENROUTER",
} as const;

const egressEnabled = () => env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED === true;

/** Process-wide cache. The switch is re-read on every call, including the fetch policy. */
export const openRouterCatalog: ProviderCatalog = createProviderCatalog({
  egressEnabled,
  fetchJson: (signal) => fetchOpenRouterCatalogJson(signal, { egressEnabled: egressEnabled() }),
});

const id = z.string().min(1).max(255);
const missing = () => new ORPCError("NOT_FOUND", { message: "Not found" });

const searchInput = z.object({
  query: z.string().trim().max(200).default(""),
  filters: z
    .object({
      tools: z.boolean().optional(),
      minContext: z
        .number()
        .int()
        .positive()
        .max(2 ** 31 - 1)
        .optional(),
      inputModalities: z
        .array(z.enum(["text", "image", "audio", "video", "file"]))
        .max(5)
        .optional(),
    })
    .default({}),
  poolId: id.optional(),
  cursor: z.number().int().min(0).max(CATALOG_MAX_MODELS).optional(),
  limit: z.number().int().min(1).max(CATALOG_SEARCH_MAX_LIMIT).default(20),
});

function catalogRow(model: CatalogModel, profile: PoolCatalogProfile | null) {
  return {
    id: model.id,
    name: model.name,
    contextLength: model.contextLength,
    maxCompletionTokens: model.maxCompletionTokens,
    pricing: {
      prompt: model.pricing.prompt,
      completion: model.pricing.completion,
      cacheRead: model.pricing.cacheRead,
      cacheWrite: model.pricing.cacheWrite,
      variable: model.pricing.variable,
    },
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    expirationDate: model.expirationDate,
    moderated: model.moderated,
    free: model.free,
    compatibility: catalogCompatibility(model, profile),
  };
}

export type ProviderCatalogRow = ReturnType<typeof catalogRow>;

async function catalogModelOrThrow(catalog: ProviderCatalog, modelId: string) {
  const result = await catalog.get();
  if (result.status === "disabled")
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "External providers are disabled for this deployment.",
      data: { reason: providerCatalogReasons.disabled },
    });
  if (result.status === "unavailable")
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "The provider catalog is unavailable. Try again later.",
      data: { reason: providerCatalogReasons.unavailable },
    });
  const model = result.models.find((entry) => entry.id === modelId);
  if (!model)
    throw new ORPCError("BAD_REQUEST", {
      message: "That model is not in the provider catalog.",
      data: { reason: providerCatalogReasons.modelNotFound },
    });
  return model;
}

function assertNotBlocked(model: CatalogModel) {
  const compatibility = catalogCompatibility(model, null);
  if (compatibility.verdict === "block")
    throw new ORPCError("BAD_REQUEST", {
      message: "That model cannot serve text chat.",
      data: { reason: providerCatalogReasons.incompatible, block: compatibility.block },
    });
}

function samePricing(
  row: { currency: string; accountingVersion: string; pricing: unknown; chargeRules: unknown },
  rates: CatalogRatesPerMillion,
): boolean {
  return (
    row.currency === "USD" &&
    row.accountingVersion === CATALOG_ACCOUNTING_VERSION &&
    stableJson(row.pricing) === stableJson({ ratesPerMillion: rates }) &&
    stableJson(row.chargeRules) === stableJson(CATALOG_CHARGE_RULES)
  );
}

type PricingOutcome = "created" | "unchanged" | "unknown" | "scheduledPricingExists";

/**
 * Makes the catalog price the model's ACTIVE pricing version. Idempotent: an
 * identical ACTIVE version is kept. A future-dated ACTIVE version (scheduled by
 * the user) is never overridden. Caller holds the account row lock; this takes
 * the per-model pricing advisory lock (same key as activatePricingVersion).
 */
async function applyCatalogPricing(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    providerAccountId: string;
    providerModelId: string;
    rates: CatalogRatesPerMillion | null;
    catalogModelId: string;
  },
): Promise<PricingOutcome> {
  if (!input.rates) return "unknown";
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-pricing:${input.userId}:${input.providerModelId}`}, 0))`;
  const active = await tx.providerPricingVersion.findMany({
    where: { userId: input.userId, providerModelId: input.providerModelId, status: "ACTIVE" },
    select: {
      id: true,
      currency: true,
      accountingVersion: true,
      pricing: true,
      chargeRules: true,
      effectiveAt: true,
    },
  });
  const now = new Date();
  const [only] = active;
  if (active.length === 1 && only && only.effectiveAt <= now && samePricing(only, input.rates))
    return "unchanged";
  if (active.some((row) => row.effectiveAt >= now)) return "scheduledPricingExists";
  await tx.providerPricingVersion.updateMany({
    where: { userId: input.userId, providerModelId: input.providerModelId, status: "ACTIVE" },
    data: { status: "RETIRED", retiredAt: now },
  });
  const pricing = { ratesPerMillion: input.rates };
  const version = `openrouter-${now.toISOString()}`;
  const row = await tx.providerPricingVersion.create({
    data: {
      userId: input.userId,
      providerAccountId: input.providerAccountId,
      providerModelId: input.providerModelId,
      version,
      currency: "USD",
      status: "ACTIVE",
      activatedAt: now,
      accountingVersion: CATALOG_ACCOUNTING_VERSION,
      confidence: "ESTIMATED",
      pricing,
      chargeRules: CATALOG_CHARGE_RULES,
      effectiveAt: now,
    },
    select: { id: true, version: true },
  });
  await tx.providerModel.update({
    where: { id: input.providerModelId },
    data: { pricingVersion: row.version, pricingMetadata: pricing },
  });
  await tx.providerAuditEvent.create({
    data: {
      userId: input.userId,
      providerAccountId: input.providerAccountId,
      action: "PRICING_ACTIVATED",
      subjectId: row.id,
      metadata: {
        version: row.version,
        source: CATALOG_SOURCE,
        catalogModelId: input.catalogModelId,
      },
    },
  });
  return "created";
}

const importedModelSelect = {
  id: true,
  providerAccountId: true,
  upstreamModelId: true,
  displayName: true,
  contextWindow: true,
  maxOutputTokens: true,
  pricingVersion: true,
  enabled: true,
} as const;

/** Factory so tests can inject a catalog; the app uses the process-wide cache. */
export function createProviderCatalogRouter(catalog: ProviderCatalog) {
  return {
    search: protectedProcedure.input(searchInput).handler(async ({ input, context }) => {
      const empty = { items: [] as ProviderCatalogRow[], nextCursor: null, total: 0 };
      // Switch first: when off, the answer is identical for every pool id, and
      // no outbound request is made.
      if (!egressEnabled())
        return { status: "disabled" as const, reason: providerCatalogReasons.disabled, ...empty };
      let profile: PoolCatalogProfile | null = null;
      if (input.poolId) {
        // Visible = owned or granted. Missing and invisible pools share one error.
        profile = await loadPoolCatalogProfile(context.session.user.id, input.poolId);
        if (!profile) throw missing();
      }
      const result = await catalog.get();
      if (result.status !== "ok") return { ...result, ...empty };
      const page = searchCatalog(result.models, {
        query: input.query,
        filters: input.filters,
        cursor: input.cursor,
        limit: input.limit,
      });
      return {
        status: "ok" as const,
        stale: result.stale,
        fetchedAt: result.fetchedAt,
        items: page.items.map((model) => catalogRow(model, profile)),
        nextCursor: page.nextCursor,
        total: page.total,
      };
    }),

    importModel: protectedProcedure
      .input(
        z.object({
          providerAccountId: id,
          modelId: catalogModelIdSchema,
          enabled: z.boolean().default(false),
        }),
      )
      .handler(async ({ input, context }) => {
        // Import is a provider-management write: same NOT_FOUND gate.
        if (!egressEnabled()) throw new ORPCError("NOT_FOUND");
        const userId = context.session.user.id;
        // Ownership before any outbound fetch, so a guessed id never costs egress.
        const owned = await prisma.providerAccount.findFirst({
          where: { id: input.providerAccountId, userId, deletedAt: null },
          select: { id: true },
        });
        if (!owned) throw missing();
        const model = await catalogModelOrThrow(catalog, input.modelId);
        assertNotBlocked(model);
        const nativeCapabilities = catalogNativeCapabilities(model) as Prisma.InputJsonValue;
        const rates = catalogRatesPerMillion(model);
        const displayName = model.name.slice(0, 255);
        // Lock order: provider_account row -> per-model pricing advisory lock ->
        // provider_model row. Matches deleteModel (account -> model) and
        // activatePricingVersion (pricing lock -> model).
        const outcome = await runSerializableTransaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
          const account = await tx.providerAccount.findFirst({
            where: { id: input.providerAccountId, userId, deletedAt: null },
            select: { id: true, providerType: true },
          });
          if (!account) throw missing();
          if (account.providerType !== OPENROUTER_PROVIDER_TYPE)
            throw new ORPCError("BAD_REQUEST", {
              message: "Catalog import needs an OpenRouter provider account.",
              data: { reason: providerCatalogReasons.notOpenRouter },
            });
          const existing = await tx.providerModel.findFirst({
            where: { userId, providerAccountId: account.id, upstreamModelId: model.id },
            select: { id: true },
          });
          let modelId: string;
          let created = false;
          let restored = false;
          let contextWindowDrift: { current: number | null; catalog: number | null } | null = null;
          if (!existing) {
            const row = await tx.providerModel.create({
              data: {
                userId,
                providerAccountId: account.id,
                upstreamModelId: model.id,
                displayName,
                nativeCapabilities,
                contextWindow: model.contextLength,
                maxOutputTokens: model.maxCompletionTokens,
                enabled: input.enabled,
              },
              select: { id: true },
            });
            modelId = row.id;
            created = true;
            // Same as createModel: the BEFORE INSERT trigger gives the target
            // its private InferenceCapacity, which admission requires.
            await tx.executionTarget.create({
              data: { userId, kind: "PROVIDER_MODEL", providerModelId: row.id },
            });
            await tx.providerAuditEvent.create({
              data: {
                userId,
                providerAccountId: account.id,
                action: "MODEL_CREATED",
                subjectId: row.id,
                metadata: { source: CATALOG_SOURCE, catalogModelId: model.id },
              },
            });
          } else {
            modelId = existing.id;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-pricing:${userId}:${modelId}`}, 0))`;
            await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${modelId} AND "userId" = ${userId} FOR UPDATE`;
            const current = await tx.providerModel.findFirst({
              where: { id: modelId, userId, providerAccountId: account.id },
              select: {
                deletedAt: true,
                displayName: true,
                nativeCapabilities: true,
                contextWindow: true,
                maxOutputTokens: true,
              },
            });
            if (!current) throw missing();
            restored = current.deletedAt !== null;
            // The context window feeds capacity policy; changing it goes through
            // updateModel's capacity checks, so a re-import only reports drift.
            if (current.contextWindow !== model.contextLength)
              contextWindowDrift = { current: current.contextWindow, catalog: model.contextLength };
            const changed =
              restored ||
              current.displayName !== displayName ||
              current.maxOutputTokens !== model.maxCompletionTokens ||
              stableJson(current.nativeCapabilities) !== stableJson(nativeCapabilities);
            if (changed) {
              await tx.providerModel.update({
                where: { id: modelId },
                data: {
                  displayName,
                  nativeCapabilities,
                  maxOutputTokens: model.maxCompletionTokens,
                  // A restored model comes back disabled, like a new one.
                  ...(restored ? { deletedAt: null, enabled: false } : {}),
                },
              });
              await tx.providerAuditEvent.create({
                data: {
                  userId,
                  providerAccountId: account.id,
                  action: "MODEL_UPDATED",
                  subjectId: modelId,
                  metadata: { source: CATALOG_SOURCE, catalogModelId: model.id, restored },
                },
              });
            }
            const target = await tx.executionTarget.findUnique({
              where: { providerModelId: modelId },
              select: { id: true },
            });
            if (!target)
              await tx.executionTarget.create({
                data: { userId, kind: "PROVIDER_MODEL", providerModelId: modelId },
              });
          }
          const pricing = await applyCatalogPricing(tx, {
            userId,
            providerAccountId: account.id,
            providerModelId: modelId,
            rates,
            catalogModelId: model.id,
          });
          const row = await tx.providerModel.findFirst({
            where: { id: modelId, userId },
            select: importedModelSelect,
          });
          if (!row) throw missing();
          return { model: row, created, restored, pricing, contextWindowDrift };
        });
        return { ...outcome, compatibility: catalogCompatibility(model, null) };
      }),

    getPoolExternalEquivalent: protectedProcedure
      .input(z.object({ poolId: id }))
      .handler(async ({ input, context }) => {
        // Read-only and owner-only; available with the switch off so the owner
        // can always see and clear the declaration.
        const pool = await prisma.modelPool.findFirst({
          where: { id: input.poolId, userId: context.session.user.id },
          select: { externalEquivalentModel: true },
        });
        if (!pool) throw missing();
        return {
          externalEquivalentModel: pool.externalEquivalentModel,
          providerEgressEnabled: egressEnabled(),
        };
      }),

    setPoolExternalEquivalent: protectedProcedure
      .input(z.object({ poolId: id, modelId: catalogModelIdSchema.nullable() }))
      .handler(async ({ input, context }) => {
        const userId = context.session.user.id;
        // Owner-only; checked before any outbound fetch.
        const pool = await prisma.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: { id: true },
        });
        if (!pool) throw missing();
        let compatibility: ReturnType<typeof catalogCompatibility> | null = null;
        if (input.modelId !== null) {
          const model = await catalogModelOrThrow(catalog, input.modelId);
          assertNotBlocked(model);
          compatibility = catalogCompatibility(
            model,
            await loadPoolCatalogProfile(userId, pool.id),
          );
        }
        const updated = await prisma.modelPool.updateMany({
          where: { id: pool.id, userId },
          data: { externalEquivalentModel: input.modelId },
        });
        if (updated.count !== 1) throw missing();
        return { externalEquivalentModel: input.modelId, compatibility };
      }),
  };
}

export const providerCatalogRouter = createProviderCatalogRouter(openRouterCatalog);
