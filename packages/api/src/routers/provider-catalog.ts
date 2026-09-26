import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { lockExecutionTargetIdentities } from "../lib/capacity-policy-safety";
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
      /** Higher rates apply above a prompt length or at some times of day. */
      tiered: model.pricing.tiers.length > 0,
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

/**
 * What the import did to the model's price. Exactly one ACTIVE price remains
 * after `created`, `updated`, `unchanged` and `userPricingKept`; none after
 * `unknown` and `catalogPricingRetired`. `scheduledPricingExists` leaves the
 * user's schedule as it was.
 */
export const catalogPricingOutcomes = [
  "created",
  "updated",
  "unchanged",
  "unknown",
  "catalogPricingRetired",
  "userPricingKept",
  "scheduledPricingExists",
] as const;
export type CatalogPricingOutcome = (typeof catalogPricingOutcomes)[number];

/**
 * Pricing versions this import path authored. The discriminator is the
 * append-only `PRICING_ACTIVATED` audit event that `applyCatalogPricing`
 * writes in the same transaction as the ACTIVE row, with
 * `metadata.source = OPENROUTER_CATALOG` and `subjectId` = the pricing row.
 * No other path writes that source (activatePricingVersion writes its own
 * event, for a different row), and `provider_audit_event` rejects UPDATE and
 * DELETE (schema-hardening.sql), so the provenance cannot change later.
 * `accountingVersion` cannot tell them apart: user prices default to the same
 * `provider-billable-v1` settlement anchor.
 */
async function catalogAuthoredPricingIds(
  tx: Prisma.TransactionClient,
  userId: string,
  pricingIds: readonly string[],
): Promise<Set<string>> {
  if (pricingIds.length === 0) return new Set();
  const events = await tx.providerAuditEvent.findMany({
    where: {
      userId,
      action: "PRICING_ACTIVATED",
      subjectId: { in: [...pricingIds] },
      metadata: { path: ["source"], equals: CATALOG_SOURCE },
    },
    select: { subjectId: true },
  });
  return new Set(events.map((event) => event.subjectId));
}

/**
 * Re-import pricing semantics (re-import is an explicit "refresh from
 * catalog"):
 * - a future-dated ACTIVE price (a user schedule) is never touched;
 * - a user-authored ACTIVE price is kept and reported (`userPricingKept`);
 * - a catalog-authored ACTIVE price is replaced when the catalog price
 *   changed, and retired when the catalog no longer gives a bounded price, so
 *   SPEND rules fail closed (PRICING_UNAVAILABLE) instead of settling on a
 *   stale rate. The model's `pricingVersion` pointer follows.
 * Caller holds the account row lock; this takes the per-model pricing
 * advisory lock (same key as activatePricingVersion) before reading prices.
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
): Promise<CatalogPricingOutcome> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-pricing:${input.userId}:${input.providerModelId}`}, 0))`;
  const active = await tx.providerPricingVersion.findMany({
    where: { userId: input.userId, providerModelId: input.providerModelId, status: "ACTIVE" },
    select: {
      id: true,
      version: true,
      currency: true,
      accountingVersion: true,
      pricing: true,
      chargeRules: true,
      effectiveAt: true,
    },
  });
  const now = new Date();
  // Checked first, so every row retired below has effectiveAt < now = retiredAt.
  if (active.some((row) => row.effectiveAt >= now)) return "scheduledPricingExists";
  const catalogAuthored = await catalogAuthoredPricingIds(
    tx,
    input.userId,
    active.map((row) => row.id),
  );
  if (active.some((row) => !catalogAuthored.has(row.id))) return "userPricingKept";
  const [only] = active;
  if (input.rates && active.length === 1 && only && samePricing(only, input.rates))
    return "unchanged";
  if (active.length > 0) {
    await tx.providerPricingVersion.updateMany({
      where: {
        userId: input.userId,
        providerModelId: input.providerModelId,
        status: "ACTIVE",
        id: { in: active.map((row) => row.id) },
      },
      data: { status: "RETIRED", retiredAt: now },
    });
    await tx.providerModel.updateMany({
      where: {
        id: input.providerModelId,
        userId: input.userId,
        pricingVersion: { in: active.map((row) => row.version) },
      },
      data: { pricingVersion: null, pricingMetadata: Prisma.JsonNull },
    });
    for (const row of active)
      await tx.providerAuditEvent.create({
        data: {
          userId: input.userId,
          providerAccountId: input.providerAccountId,
          action: "PRICING_RETIRED",
          subjectId: row.id,
          metadata: {
            version: row.version,
            source: CATALOG_SOURCE,
            catalogModelId: input.catalogModelId,
          },
        },
      });
  }
  if (!input.rates) return active.length > 0 ? "catalogPricingRetired" : "unknown";
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
  // This event is the catalog-authorship record (catalogAuthoredPricingIds).
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
  return active.length > 0 ? "updated" : "created";
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
        // Lock order (capacity-lock-order L0 first, then provider rows):
        //   execution-target:provider-model:<id> identity fence (existing
        //   model only) -> provider_account row -> per-model pricing advisory
        //   lock -> provider_model row.
        // The fence matches updateModel and provider attach, which take it
        // before the account row. It is needed whenever this import can create
        // (backfill) the model's execution target. A brand-new model needs no
        // fence: its id is not visible to any other transaction until commit,
        // exactly as in createModel.
        // The pre-lock read establishes the serializable snapshot; a
        // concurrent insert, delete or restore of that row fails this
        // transaction with a serialization error, which is retried.
        const outcome = await runSerializableTransaction(async (tx) => {
          const known = await tx.providerModel.findFirst({
            where: {
              userId,
              providerAccountId: input.providerAccountId,
              upstreamModelId: model.id,
            },
            select: { id: true },
          });
          if (known) await lockExecutionTargetIdentities(tx, [`provider-model:${known.id}`]);
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
          let modelId: string;
          let created = false;
          let restored = false;
          let contextWindowDrift: { current: number | null; catalog: number | null } | null = null;
          if (!known) {
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
            modelId = known.id;
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-pricing:${userId}:${modelId}`}, 0))`;
            await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${modelId} AND "userId" = ${userId} FOR UPDATE`;
            const current = await tx.providerModel.findFirst({
              where: { id: modelId, userId, providerAccountId: account.id },
              select: {
                deletedAt: true,
                nativeCapabilities: true,
                contextWindow: true,
                maxOutputTokens: true,
              },
            });
            if (!current) throw missing();
            restored = current.deletedAt !== null;
            // Re-import refreshes catalog-owned facts only. The display name
            // and enabled flag are the owner's (a restore comes back disabled).
            // The context window feeds capacity policy; changing it goes
            // through updateModel's capacity checks, so it is only reported.
            if (current.contextWindow !== model.contextLength)
              contextWindowDrift = { current: current.contextWindow, catalog: model.contextLength };
            // An absent catalog maximum never clears the stored one.
            const maxOutputTokens =
              model.maxCompletionTokens !== null &&
              model.maxCompletionTokens !== current.maxOutputTokens
                ? model.maxCompletionTokens
                : undefined;
            const capabilitiesChanged =
              stableJson(current.nativeCapabilities) !== stableJson(nativeCapabilities);
            if (restored || maxOutputTokens !== undefined || capabilitiesChanged) {
              await tx.providerModel.update({
                where: { id: modelId },
                data: {
                  ...(capabilitiesChanged ? { nativeCapabilities } : {}),
                  ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
            // Backfill: admission needs a target (and so capacity). Fenced by
            // the L0 identity lock taken first in this transaction.
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
        return {
          ...outcome,
          // The imported rates are the upper bound across these tiers.
          priceTiered: rates !== null && model.pricing.tiers.length > 0,
          compatibility: catalogCompatibility(model, null),
        };
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
