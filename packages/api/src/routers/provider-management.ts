import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { openAiCompatibleCapabilitiesSchema } from "../lib/openai-compatible-capabilities";
import {
  decryptProviderCredential,
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "../lib/provider-credential-crypto";
import {
  providerHttpsRequest,
  redactProviderError,
  validateProviderBaseUrl,
} from "../lib/provider-egress";

const id = z.string().min(1);
const missing = () => new ORPCError("NOT_FOUND", { message: "Not found" });
function enabled(): void {
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED) throw new ORPCError("NOT_FOUND");
}
const policy = () => ({
  allowPrivateNetworks: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
  egressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
});
const providerWriteTransaction = {
  isolationLevel: "Serializable" as const,
  maxWait: 5_000,
  timeout: 10_000,
} as const;
const ring = () => {
  if (!env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS)
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Provider credential encryption is not configured",
    });
  return parseProviderCredentialKeyring(env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS);
};
const accountSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  providerType: true,
  providerVersion: true,
  label: true,
  baseUrl: true,
  endpointIdentity: true,
  endpointVersion: true,
  authType: true,
  status: true,
  enabled: true,
  safeConfiguration: true,
  healthStatus: true,
  healthCheckedAt: true,
  currentCredentialId: true,
} as const;
const modelSelect = {
  id: true,
  createdAt: true,
  updatedAt: true,
  providerAccountId: true,
  upstreamModelId: true,
  displayName: true,
  capabilityMetadata: true,
  nativeCapabilities: true,
  contextWindow: true,
  maxOutputTokens: true,
  concurrencyLimit: true,
  pricingMetadata: true,
  pricingVersion: true,
  healthStatus: true,
  healthCheckedAt: true,
  enabled: true,
} as const;
async function accountFor(userId: string, accountId: string) {
  const row = await prisma.providerAccount.findFirst({
    where: { id: accountId, userId, deletedAt: null },
  });
  if (!row) throw missing();
  return row;
}
async function historicalAccountFor(userId: string, accountId: string) {
  const row = await prisma.providerAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!row) throw missing();
  return row;
}
async function reportScopeFor(
  userId: string,
  input: { providerAccountId?: string; providerModelId?: string; poolId?: string },
) {
  if (input.providerAccountId) await historicalAccountFor(userId, input.providerAccountId);
  if (input.providerModelId) {
    const model = await prisma.providerModel.findFirst({
      where: {
        id: input.providerModelId,
        userId,
        ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
      },
      select: { id: true },
    });
    if (!model) throw missing();
  }
  if (input.poolId) {
    const pool = await prisma.modelPool.findFirst({
      where: { id: input.poolId, userId },
      select: { id: true },
    });
    if (!pool) throw missing();
  }
}
const reportInput = z
  .object({
    providerAccountId: id.optional(),
    providerModelId: id.optional(),
    poolId: id.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from >= value.to)
      ctx.addIssue({ code: "custom", message: "from must be before to" });
  });
const reportCursor = z.object({ createdAt: z.coerce.date(), id });
const pagedReportInput = reportInput.extend({ cursor: reportCursor.optional() });
function reportWhere(userId: string, input: z.infer<typeof reportInput>) {
  return {
    userId,
    ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
    ...(input.providerModelId ? { providerModelId: input.providerModelId } : {}),
    ...(input.poolId ? { poolId: input.poolId } : {}),
    ...(input.from || input.to
      ? {
          createdAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lt: input.to } : {}),
          },
        }
      : {}),
  };
}
function cursorWhere(cursor: z.infer<typeof reportCursor> | undefined) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}
function page<T extends { id: string; createdAt: Date }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}
const json = z.record(z.string(), z.unknown()).nullable().optional();
const accountInput = z.object({
  providerType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  providerVersion: z.string().trim().min(1).max(64).nullable().optional(),
  label: z.string().trim().min(1).max(120),
  baseUrl: z.string().url().max(2048),
  authType: z.enum(["API_KEY", "BEARER"]),
  safeConfiguration: json,
});
const modelInput = z.object({
  providerAccountId: id,
  upstreamModelId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255).nullable().optional(),
  capabilityMetadata: json,
  nativeCapabilities: openAiCompatibleCapabilitiesSchema.nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  concurrencyLimit: z.number().int().positive().nullable().optional(),
  pricingMetadata: json,
  pricingVersion: z.string().trim().min(1).max(128).nullable().optional(),
  enabled: z.boolean().default(false),
});
const moneyRate = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u);
const pricingRates = z
  .object({
    input: moneyRate,
    output: moneyRate,
    cacheRead: moneyRate.optional(),
    cacheWrite: moneyRate.optional(),
    reasoning: moneyRate.optional(),
    tool: moneyRate.optional(),
    additional: moneyRate.optional(),
  })
  .strict();
const chargeRules = z
  .object({
    inputIncludesCacheRead: z.boolean().default(false),
    inputIncludesCacheWrite: z.boolean().default(false),
    outputIncludesReasoning: z.boolean().default(false),
    outputIncludesTool: z.boolean().default(false),
    reasoningAllowanceTokens: z.number().int().nonnegative(),
    toolAllowanceTokens: z.number().int().nonnegative(),
    cacheReadAllowanceTokens: z.number().int().nonnegative(),
    cacheWriteAllowanceTokens: z.number().int().nonnegative(),
    additionalAllowanceTokens: z.number().int().nonnegative(),
    unknownCategories: z.literal("FAIL_CLOSED"),
  })
  .strict();
const pricingInput = z.object({
  providerModelId: id,
  version: z.string().trim().min(1).max(128),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/u),
  accountingVersion: z.string().trim().min(1).max(128),
  confidence: z.enum(["CALCULATED", "ESTIMATED"]),
  ratesPerMillion: pricingRates,
  chargeRules,
  effectiveAt: z.coerce.date(),
});
const pricingSelect = {
  id: true,
  createdAt: true,
  providerAccountId: true,
  providerModelId: true,
  version: true,
  currency: true,
  status: true,
  accountingVersion: true,
  confidence: true,
  pricing: true,
  chargeRules: true,
  effectiveAt: true,
  activatedAt: true,
  retiredAt: true,
} as const;
const rule = z
  .object({
    metric: z.enum(["CONCURRENCY", "TOKENS", "SPEND"]),
    period: z.enum(["PER_ATTEMPT", "UTC_DAY", "UTC_MONTH", "LIFETIME"]),
    mode: z.enum(["LIMITED", "UNLIMITED"]),
    limitValue: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u)
      .nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
  })
  .superRefine((v, ctx) => {
    if ((v.mode === "LIMITED") !== (v.limitValue !== null) || v.limitValue === "0")
      ctx.addIssue({
        code: "custom",
        message: "LIMITED requires a positive value; UNLIMITED requires null",
      });
    if ((v.metric === "SPEND") !== (v.currency !== null))
      ctx.addIssue({ code: "custom", message: "Currency is required only for spend" });
    if (v.metric === "SPEND" && !["UTC_DAY", "UTC_MONTH"].includes(v.period))
      ctx.addIssue({ code: "custom", message: "Invalid spend period" });
    if (v.metric === "CONCURRENCY" && v.period !== "PER_ATTEMPT")
      ctx.addIssue({ code: "custom", message: "Concurrency uses PER_ATTEMPT" });
    if (v.metric !== "SPEND" && v.limitValue !== null && !/^\d+$/u.test(v.limitValue))
      ctx.addIssue({ code: "custom", message: "Token and concurrency limits must be integers" });
  });

function budgetAuditMetadata(
  rules: readonly z.infer<typeof rule>[],
  extra: Record<string, string> = {},
): Prisma.InputJsonObject {
  return {
    ...extra,
    // UNLIMITED is an explicit safety decision, not an omitted limit. Record
    // only non-secret rule identity so an audit reader can distinguish it from
    // a missing protection rule without exposing values or provider details.
    unlimitedRules: rules
      .filter(({ mode }) => mode === "UNLIMITED")
      .map(({ metric, period }) => ({ metric, period })),
  };
}

export const providerManagementRouter = {
  listAccounts: protectedProcedure.handler(({ context }) => {
    enabled();
    return prisma.providerAccount.findMany({
      where: { userId: context.session.user.id, deletedAt: null },
      orderBy: [{ label: "asc" }, { id: "asc" }],
      select: accountSelect,
    });
  }),
  createAccount: protectedProcedure.input(accountInput).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    const baseUrl = validateProviderBaseUrl(input.baseUrl, policy()).href.replace(/\/$/u, "");
    return prisma.$transaction(async (tx) => {
      const row = await tx.providerAccount.create({
        data: {
          ...input,
          baseUrl,
          endpointIdentity: baseUrl,
          userId,
          safeConfiguration: input.safeConfiguration as Prisma.InputJsonValue | undefined,
          enabled: false,
          status: "DISABLED",
        },
        select: accountSelect,
      });
      await tx.providerAuditEvent.create({
        data: { userId, providerAccountId: row.id, action: "ACCOUNT_CREATED", subjectId: row.id },
      });
      return row;
    });
  }),
  updateAccount: protectedProcedure
    .input(accountInput.partial().extend({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const { id: accountId, ...data } = input;
      if (data.baseUrl) {
        data.baseUrl = validateProviderBaseUrl(data.baseUrl, policy()).href.replace(/\/$/u, "");
      }
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${accountId} AND "userId" = ${userId} FOR UPDATE`;
        const current = await tx.providerAccount.findFirst({
          where: { id: accountId, userId, deletedAt: null },
        });
        if (!current) throw missing();
        if (data.authType && data.authType !== current.authType) {
          const credentialCount = await tx.providerCredential.count({
            where: { userId, providerAccountId: accountId },
          });
          if (credentialCount > 0)
            throw new ORPCError("CONFLICT", {
              message: "Replace or revoke provider credentials before changing authentication type",
            });
        }
        const endpointChanged = data.baseUrl !== undefined && data.baseUrl !== current.baseUrl;
        const updated = await tx.providerAccount.updateMany({
          where: { id: accountId, userId, deletedAt: null },
          data: {
            ...(data as Prisma.ProviderAccountUpdateInput),
            ...(endpointChanged
              ? { endpointIdentity: data.baseUrl, endpointVersion: { increment: 1 } }
              : {}),
          },
        });
        if (updated.count !== 1) throw missing();
        const row = await tx.providerAccount.findFirst({
          where: { id: accountId, userId, deletedAt: null },
          select: accountSelect,
        });
        if (!row) throw missing();
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: accountId,
            action: "ACCOUNT_UPDATED",
            subjectId: accountId,
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  setAccountEnabled: protectedProcedure
    .input(z.object({ id, enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.id} AND "userId" = ${userId} FOR UPDATE`;
        const account = await tx.providerAccount.findFirst({
          where: { id: input.id, userId, deletedAt: null },
          select: { id: true, currentCredentialId: true, enabled: true },
        });
        if (!account) throw missing();
        if (input.enabled) {
          if (!account.currentCredentialId)
            throw new ORPCError("PRECONDITION_FAILED", {
              message: "An active credential is required",
            });
          const credential = await tx.providerCredential.findFirst({
            where: {
              id: account.currentCredentialId,
              userId,
              providerAccountId: account.id,
              status: "ACTIVE",
            },
            select: { id: true },
          });
          if (!credential) throw new ORPCError("PRECONDITION_FAILED");
          const enabledModels = await tx.providerModel.count({
            where: { userId, providerAccountId: account.id, deletedAt: null, enabled: true },
          });
          if (enabledModels === 0)
            throw new ORPCError("PRECONDITION_FAILED", {
              message: "At least one enabled provider model is required",
            });
        }
        if (account.enabled !== input.enabled) {
          await tx.providerAccount.updateMany({
            where: { id: account.id, userId, deletedAt: null },
            data: { enabled: input.enabled, status: input.enabled ? "ACTIVE" : "DISABLED" },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: account.id,
              action: "ACCOUNT_UPDATED",
              subjectId: account.id,
              metadata: { enabled: input.enabled },
            },
          });
        }
        const row = await tx.providerAccount.findFirst({
          where: { id: account.id, userId, deletedAt: null },
          select: accountSelect,
        });
        if (!row) throw missing();
        return row;
      }, providerWriteTransaction);
    }),
  deleteAccount: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.id} AND "userId" = ${userId} FOR UPDATE`;
      const account = await tx.providerAccount.findFirst({
        where: { id: input.id, userId, deletedAt: null },
        select: { id: true },
      });
      if (!account) throw missing();
      const deleted = await tx.providerAccount.updateMany({
        where: { id: input.id, userId, deletedAt: null },
        data: { deletedAt: now, enabled: false, status: "DISABLED", currentCredentialId: null },
      });
      if (deleted.count !== 1) throw new ORPCError("CONFLICT");
      await tx.providerModel.updateMany({
        where: { userId, providerAccountId: input.id },
        data: { deletedAt: now, enabled: false },
      });
      await tx.providerCredential.updateMany({
        where: { userId, providerAccountId: input.id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now },
      });
      await tx.providerAuditEvent.create({
        data: {
          userId,
          providerAccountId: input.id,
          action: "ACCOUNT_DELETED",
          subjectId: input.id,
        },
      });
    }, providerWriteTransaction);
    return { success: true };
  }),
  listModels: protectedProcedure
    .input(z.object({ providerAccountId: id }))
    .handler(async ({ input, context }) => {
      enabled();
      await accountFor(context.session.user.id, input.providerAccountId);
      return prisma.providerModel.findMany({
        where: {
          userId: context.session.user.id,
          providerAccountId: input.providerAccountId,
          deletedAt: null,
        },
        select: modelSelect,
      });
    }),
  createModel: protectedProcedure.input(modelInput).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
      const account = await tx.providerAccount.findFirst({
        where: { id: input.providerAccountId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!account) throw missing();
      const row = await tx.providerModel.create({
        data: {
          ...input,
          userId,
          capabilityMetadata: input.capabilityMetadata as Prisma.InputJsonValue | undefined,
          nativeCapabilities: input.nativeCapabilities as Prisma.InputJsonValue | undefined,
          pricingMetadata: input.pricingMetadata as Prisma.InputJsonValue | undefined,
        },
        select: modelSelect,
      });
      await tx.executionTarget.create({
        data: { userId, kind: "PROVIDER_MODEL", providerModelId: row.id },
      });
      await tx.providerAuditEvent.create({
        data: {
          userId,
          providerAccountId: input.providerAccountId,
          action: "MODEL_CREATED",
          subjectId: row.id,
        },
      });
      return row;
    }, providerWriteTransaction);
  }),
  updateModel: protectedProcedure
    .input(
      modelInput
        .omit({ providerAccountId: true, upstreamModelId: true })
        .partial()
        .extend({ id, enabled: z.boolean().optional() }),
    )
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const { id: modelId, ...data } = input;
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT a.id FROM provider_account a WHERE a.id = (SELECT m."providerAccountId" FROM provider_model m WHERE m.id = ${modelId} AND m."userId" = ${userId}) AND a."userId" = ${userId} FOR UPDATE`;
        const current = await tx.providerModel.findFirst({
          where: { id: modelId, userId, deletedAt: null, ProviderAccount: { deletedAt: null } },
        });
        if (!current) throw missing();
        const account = await tx.providerAccount.findFirst({
          where: { id: current.providerAccountId, userId, deletedAt: null },
          select: { id: true },
        });
        if (!account) throw missing();
        const row = await tx.providerModel.update({
          where: { id: modelId },
          data: data as Prisma.ProviderModelUpdateInput,
          select: modelSelect,
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: current.providerAccountId,
            action: "MODEL_UPDATED",
            subjectId: modelId,
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  deleteModel: protectedProcedure.input(z.object({ id })).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT a.id FROM provider_account a WHERE a.id = (SELECT m."providerAccountId" FROM provider_model m WHERE m.id = ${input.id} AND m."userId" = ${userId}) AND a."userId" = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM provider_model WHERE id = ${input.id} AND "userId" = ${userId} FOR UPDATE`;
      const current = await tx.providerModel.findFirst({
        where: {
          id: input.id,
          userId,
          deletedAt: null,
          ProviderAccount: { deletedAt: null },
        },
      });
      if (!current) throw missing();
      const deleted = await tx.providerModel.updateMany({
        where: {
          id: input.id,
          userId,
          providerAccountId: current.providerAccountId,
          deletedAt: null,
        },
        data: { deletedAt: new Date(), enabled: false },
      });
      if (deleted.count !== 1) throw missing();
      await tx.providerAuditEvent.create({
        data: {
          userId,
          providerAccountId: current.providerAccountId,
          action: "MODEL_DELETED",
          subjectId: input.id,
        },
      });
    }, providerWriteTransaction);
    return { success: true };
  }),
  listPricingVersions: protectedProcedure
    .input(z.object({ providerModelId: id }))
    .handler(async ({ input, context }) => {
      enabled();
      const model = await prisma.providerModel.findFirst({
        where: {
          id: input.providerModelId,
          userId: context.session.user.id,
          deletedAt: null,
          ProviderAccount: { deletedAt: null },
        },
        select: { id: true },
      });
      if (!model) throw missing();
      return prisma.providerPricingVersion.findMany({
        where: { userId: context.session.user.id, providerModelId: model.id },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
        select: pricingSelect,
      });
    }),
  createPricingVersion: protectedProcedure
    .input(pricingInput)
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        const model = await tx.providerModel.findFirst({
          where: {
            id: input.providerModelId,
            userId,
            deletedAt: null,
            ProviderAccount: { deletedAt: null },
          },
          select: { id: true, providerAccountId: true },
        });
        if (!model) throw missing();
        const row = await tx.providerPricingVersion.create({
          data: {
            userId,
            providerAccountId: model.providerAccountId,
            providerModelId: model.id,
            version: input.version,
            currency: input.currency,
            status: "DRAFT",
            activatedAt: null,
            accountingVersion: input.accountingVersion,
            confidence: input.confidence,
            pricing: { ratesPerMillion: input.ratesPerMillion },
            chargeRules: input.chargeRules,
            effectiveAt: input.effectiveAt,
          },
          select: pricingSelect,
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: model.providerAccountId,
            action: "PRICING_CREATED",
            subjectId: row.id,
            metadata: { version: row.version, status: row.status },
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  updatePricingVersion: protectedProcedure
    .input(pricingInput.omit({ providerModelId: true, version: true }).partial().extend({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const { id: pricingId, ratesPerMillion, chargeRules: rules, ...data } = input;
      return prisma.$transaction(async (tx) => {
        const current = await tx.providerPricingVersion.findFirst({
          where: {
            id: pricingId,
            userId,
            status: "DRAFT",
            ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
          },
        });
        if (!current) throw missing();
        const row = await tx.providerPricingVersion.update({
          where: { id: current.id },
          data: {
            ...data,
            ...(ratesPerMillion ? { pricing: { ratesPerMillion } } : {}),
            ...(rules ? { chargeRules: rules } : {}),
          },
          select: pricingSelect,
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: current.providerAccountId,
            action: "PRICING_UPDATED",
            subjectId: row.id,
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  activatePricingVersion: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      return prisma.$transaction(async (tx) => {
        const now = new Date();
        const candidate = await tx.providerPricingVersion.findFirst({
          where: {
            id: input.id,
            userId,
            status: "DRAFT",
            ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
          },
        });
        if (!candidate) throw missing();
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-pricing:${userId}:${candidate.providerModelId}`}, 0))`;
        const current = await tx.providerPricingVersion.findFirst({
          where: {
            id: candidate.id,
            userId,
            status: "DRAFT",
            ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
          },
        });
        if (!current) throw new ORPCError("CONFLICT", { message: "Pricing version changed" });
        const prior = await tx.providerPricingVersion.findMany({
          where: { userId, providerModelId: current.providerModelId, status: "ACTIVE" },
          select: { id: true, effectiveAt: true },
        });
        if (prior.some((row) => row.effectiveAt >= current.effectiveAt))
          throw new ORPCError("CONFLICT", {
            message: "Pricing activation must advance the effective time",
          });
        await tx.providerPricingVersion.updateMany({
          where: { userId, providerModelId: current.providerModelId, status: "ACTIVE" },
          data: { status: "RETIRED", retiredAt: current.effectiveAt },
        });
        const row = await tx.providerPricingVersion.update({
          where: { id: current.id },
          data: { status: "ACTIVE", activatedAt: now, retiredAt: null },
          select: pricingSelect,
        });
        if (current.effectiveAt <= now)
          await tx.providerModel.update({
            where: { id: current.providerModelId },
            data: {
              pricingVersion: current.version,
              pricingMetadata: current.pricing as Prisma.InputJsonValue,
            },
          });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: current.providerAccountId,
            action: "PRICING_ACTIVATED",
            subjectId: row.id,
            metadata: { version: row.version },
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  retirePricingVersion: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await prisma.$transaction(async (tx) => {
        const current = await tx.providerPricingVersion.findFirst({
          where: {
            id: input.id,
            userId,
            status: "ACTIVE",
            ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
          },
        });
        if (!current) throw missing();
        const now = new Date();
        const retiredAt =
          now > current.effectiveAt ? now : new Date(current.effectiveAt.getTime() + 1);
        await tx.providerPricingVersion.update({
          where: { id: current.id },
          data: { status: "RETIRED", retiredAt },
        });
        await tx.providerModel.updateMany({
          where: { id: current.providerModelId, userId, pricingVersion: current.version },
          data: { pricingVersion: null, pricingMetadata: Prisma.JsonNull },
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: current.providerAccountId,
            action: "PRICING_RETIRED",
            subjectId: current.id,
          },
        });
      }, providerWriteTransaction);
      return { success: true };
    }),
  deletePricingVersion: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await prisma.$transaction(async (tx) => {
        const current = await tx.providerPricingVersion.findFirst({
          where: {
            id: input.id,
            userId,
            status: "DRAFT",
            ProviderModel: { deletedAt: null, ProviderAccount: { deletedAt: null } },
          },
        });
        if (!current) throw missing();
        await tx.providerPricingVersion.delete({ where: { id: current.id } });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: current.providerAccountId,
            action: "PRICING_DELETED",
            subjectId: current.id,
          },
        });
      }, providerWriteTransaction);
      return { success: true };
    }),
  listCredentials: protectedProcedure
    .input(z.object({ providerAccountId: id }))
    .handler(async ({ input, context }) => {
      enabled();
      await accountFor(context.session.user.id, input.providerAccountId);
      return prisma.providerCredential.findMany({
        where: { userId: context.session.user.id, providerAccountId: input.providerAccountId },
        select: {
          id: true,
          createdAt: true,
          credentialType: true,
          keyVersion: true,
          displaySuffix: true,
          status: true,
          replacedAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
      });
    }),
  createCredential: protectedProcedure
    .input(z.object({ providerAccountId: id, credential: z.string().min(1).max(16_384) }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const credentialId = randomUUID();
      return prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`;
          const account = await tx.providerAccount.findFirst({
            where: { id: input.providerAccountId, userId, deletedAt: null },
          });
          if (!account) throw missing();
          if (account.currentCredentialId) throw new ORPCError("CONFLICT");
          const encrypted = encryptProviderCredential(
            input.credential,
            {
              userId,
              providerAccountId: account.id,
              credentialId,
              credentialType: account.authType,
              aadVersion: 1,
            },
            ring(),
          );
          const row = await tx.providerCredential.create({
            data: {
              id: credentialId,
              userId,
              providerAccountId: account.id,
              credentialType: account.authType,
              ...encrypted,
            },
            select: {
              id: true,
              createdAt: true,
              credentialType: true,
              keyVersion: true,
              displaySuffix: true,
              status: true,
            },
          });
          await tx.providerAccount.update({
            where: { id: account.id },
            data: { currentCredentialId: row.id },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: account.id,
              action: "CREDENTIAL_CREATED",
              subjectId: row.id,
            },
          });
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),
  replaceCredential: protectedProcedure
    .input(z.object({ providerAccountId: id, credential: z.string().min(1).max(16_384) }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const credentialId = randomUUID();
      return prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${userId} AND "deletedAt" IS NULL FOR UPDATE`;
          const account = await tx.providerAccount.findFirst({
            where: { id: input.providerAccountId, userId, deletedAt: null },
          });
          if (!account?.currentCredentialId) throw missing();
          const encrypted = encryptProviderCredential(
            input.credential,
            {
              userId,
              providerAccountId: account.id,
              credentialId,
              credentialType: account.authType,
              aadVersion: 1,
            },
            ring(),
          );
          const deactivated = await tx.providerCredential.updateMany({
            where: { id: account.currentCredentialId, userId, status: "ACTIVE" },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
          if (deactivated.count !== 1) throw new ORPCError("CONFLICT");
          const row = await tx.providerCredential.create({
            data: {
              id: credentialId,
              userId,
              providerAccountId: account.id,
              credentialType: account.authType,
              ...encrypted,
            },
            select: {
              id: true,
              createdAt: true,
              credentialType: true,
              keyVersion: true,
              displaySuffix: true,
              status: true,
            },
          });
          await tx.providerCredential.update({
            where: { id: account.currentCredentialId },
            data: {
              status: "REPLACED",
              replacedAt: new Date(),
              replacedById: row.id,
              revokedAt: null,
            },
          });
          await tx.providerAccount.update({
            where: { id: account.id },
            data: { currentCredentialId: row.id },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: account.id,
              action: "CREDENTIAL_REPLACED",
              subjectId: row.id,
            },
          });
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),
  revokeCredential: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const candidate = await prisma.providerCredential.findFirst({
        where: { id: input.id, userId },
        select: { id: true, providerAccountId: true },
      });
      if (!candidate) throw missing();
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${candidate.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM provider_credential WHERE id = ${candidate.id} AND "userId" = ${userId} FOR UPDATE`;
          const row = await tx.providerCredential.findFirst({
            where: { id: candidate.id, userId, ProviderAccount: { deletedAt: null } },
          });
          if (!row) throw missing();
          const changed = await tx.providerCredential.updateMany({
            where: { id: row.id, userId, status: { not: "REVOKED" } },
            data: { status: "REVOKED", revokedAt: new Date() },
          });
          if (changed.count === 0) return;
          await tx.providerAccount.updateMany({
            where: { id: row.providerAccountId, userId, currentCredentialId: row.id },
            data: { currentCredentialId: null, enabled: false, status: "DISABLED" },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: row.providerAccountId,
              action: "CREDENTIAL_REVOKED",
              subjectId: row.id,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { success: true };
    }),
  listAuditEvents: protectedProcedure
    .input(
      z.object({
        providerAccountId: id.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .handler(async ({ input, context }) => {
      enabled();
      if (input.providerAccountId)
        await historicalAccountFor(context.session.user.id, input.providerAccountId);
      return prisma.providerAuditEvent.findMany({
        where: {
          userId: context.session.user.id,
          ...(input.providerAccountId ? { providerAccountId: input.providerAccountId } : {}),
        },
        select: {
          id: true,
          createdAt: true,
          providerAccountId: true,
          action: true,
          subjectId: true,
          metadata: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      });
    }),
  listUsageReport: protectedProcedure.input(reportInput).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    await reportScopeFor(userId, input);
    return prisma.providerUsageLedger.findMany({
      where: reportWhere(userId, input),
      select: {
        id: true,
        createdAt: true,
        providerAccountId: true,
        providerModelId: true,
        poolId: true,
        requestId: true,
        attemptId: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        reasoningTokens: true,
        toolTokens: true,
        additionalBillableTokens: true,
        authoritativeBillableTokens: true,
        reportedTotalTokens: true,
        billableTotal: true,
        categoriesComplete: true,
        reportedCost: true,
        reportedCostCurrency: true,
        calculatedCost: true,
        calculatedCostCurrency: true,
        settledCost: true,
        currency: true,
        pricingVersion: true,
        accountingVersion: true,
        usageKnown: true,
        costKnown: true,
        terminalReason: true,
        confidence: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
    });
  }),
  listBudgetActivity: protectedProcedure.input(reportInput).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    await reportScopeFor(userId, input);
    const where = reportWhere(userId, input);
    const [reservations, settlements] = await Promise.all([
      prisma.providerBudgetReservation.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          settledAt: true,
          expiresAt: true,
          providerAccountId: true,
          providerModelId: true,
          poolId: true,
          policyId: true,
          ruleId: true,
          requestId: true,
          attemptId: true,
          fencingToken: true,
          metric: true,
          period: true,
          policyVersion: true,
          utcBasis: true,
          windowStart: true,
          windowEnd: true,
          reservedValue: true,
          liabilityTokens: true,
          liabilitySpend: true,
          liabilityCurrency: true,
          settledValue: true,
          currency: true,
          pricingVersion: true,
          accountingVersion: true,
          state: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      }),
      prisma.providerBudgetSettlement.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          providerAccountId: true,
          providerModelId: true,
          poolId: true,
          requestId: true,
          reservationId: true,
          attemptId: true,
          pricingVersion: true,
          accountingVersion: true,
          settledValue: true,
          currency: true,
          confidence: true,
          reason: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      }),
    ]);
    return {
      reservations,
      settlements,
      caveats: [
        "FAILED_OR_CANCELLED_MAY_BILL",
        "USAGE_CATEGORIES_MAY_BE_OMITTED",
        "STREAM_FINAL_USAGE_MAY_BE_MISSING",
        "PRICING_MAY_CHANGE",
        "FX_IS_INEXACT_AND_NOT_CONVERTED",
        "INVOICES_ARE_AUTHORITATIVE",
        "BUDGETS_ARE_NOT_GUARANTEED_CAPS",
      ] as const,
    };
  }),
  listProviderAttemptEvents: protectedProcedure
    .input(reportInput)
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await reportScopeFor(userId, input);
      return prisma.publicProviderAttemptEvent.findMany({
        where: reportWhere(userId, input),
        select: {
          id: true,
          createdAt: true,
          providerAccountId: true,
          providerModelId: true,
          requestId: true,
          attemptId: true,
          eventType: true,
          reason: true,
          requestedSurface: true,
          nativeSurface: true,
          adapterMode: true,
          adapterVersion: true,
          poolId: true,
          poolMemberId: true,
          executionTargetId: true,
          memberTier: true,
          triggerReason: true,
          affinityOutcome: true,
          contextCountMethod: true,
          contextCountConfidence: true,
          waitDurationMs: true,
          reservationId: true,
          contextTokens: true,
          firstClientByteAt: true,
          streamCommitted: true,
          terminalState: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
      });
    }),
  listUsageReportPage: protectedProcedure
    .input(pagedReportInput)
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await reportScopeFor(userId, input);
      const rows = await prisma.providerUsageLedger.findMany({
        where: { ...reportWhere(userId, input), ...cursorWhere(input.cursor) },
        select: {
          id: true,
          createdAt: true,
          providerAccountId: true,
          providerModelId: true,
          poolId: true,
          requestId: true,
          attemptId: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          reasoningTokens: true,
          toolTokens: true,
          additionalBillableTokens: true,
          authoritativeBillableTokens: true,
          reportedTotalTokens: true,
          billableTotal: true,
          categoriesComplete: true,
          rawUsage: true,
          reportedCost: true,
          reportedCostCurrency: true,
          reportedCostPricingVersion: true,
          reportedCostSource: true,
          calculatedCost: true,
          calculatedCostCurrency: true,
          calculatedCostPricingVersion: true,
          calculatedCostSource: true,
          settledCost: true,
          currency: true,
          pricingVersion: true,
          accountingVersion: true,
          usageKnown: true,
          costKnown: true,
          terminalReason: true,
          confidence: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      });
      return page(rows, input.limit);
    }),
  getUsageTotals: protectedProcedure.input(reportInput).handler(async ({ input, context }) => {
    enabled();
    const userId = context.session.user.id;
    await reportScopeFor(userId, input);
    const where = reportWhere(userId, input);
    const [groups, excludedRowCount] = await Promise.all([
      prisma.providerUsageLedger.groupBy({
        by: ["currency"],
        where: {
          ...where,
          costKnown: true,
          currency: { not: null },
          settledCost: { not: null },
        },
        _sum: { settledCost: true },
        _count: { _all: true },
        orderBy: { currency: "asc" },
      }),
      prisma.providerUsageLedger.count({
        where: {
          ...where,
          OR: [{ costKnown: false }, { currency: null }, { settledCost: null }],
        },
      }),
    ]);
    return {
      totals: groups.map((group) => ({
        currency: group.currency,
        settledCost: group._sum.settledCost,
        rowCount: group._count._all,
        from: input.from ?? null,
        to: input.to ?? null,
      })),
      excludedRowCount,
    };
  }),
  listProviderAttempts: protectedProcedure
    .input(pagedReportInput)
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await reportScopeFor(userId, input);
      const now = new Date();
      const rows = await prisma.providerAttempt.findMany({
        where: { ...reportWhere(userId, input), ...cursorWhere(input.cursor) },
        select: {
          id: true,
          createdAt: true,
          providerAccountId: true,
          providerModelId: true,
          poolId: true,
          requestId: true,
          attemptId: true,
          fencingToken: true,
          state: true,
          heartbeatAt: true,
          terminalAt: true,
          terminalReason: true,
          expiresAt: true,
          liabilityTokens: true,
          liabilitySpend: true,
          liabilityCurrency: true,
          pricingVersion: true,
          accountingVersion: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
      });
      const result = page(rows, input.limit);
      const attemptKeys = result.items.map((row) => ({
        attemptId: row.attemptId,
        fencingToken: row.fencingToken,
      }));
      const ledgerCounts = attemptKeys.length
        ? await prisma.providerUsageLedger.groupBy({
            by: ["attemptId", "fencingToken"],
            where: { userId, OR: attemptKeys },
            _count: { _all: true },
          })
        : [];
      const accountingKey = (attemptId: string, fencingToken: bigint) =>
        `${attemptId}:${fencingToken.toString()}`;
      const counts = new Map(
        ledgerCounts.map((row) => [
          accountingKey(row.attemptId, row.fencingToken),
          row._count._all,
        ]),
      );
      return {
        ...result,
        items: result.items.map((row) => ({
          ...row,
          stale: row.state === "ACTIVE" && row.expiresAt <= now,
          reconciliationStatus:
            (counts.get(accountingKey(row.attemptId, row.fencingToken)) ?? 0) > 0
              ? "RECORDED"
              : row.state === "ACTIVE"
                ? "PENDING"
                : "MISSING",
        })),
      };
    }),
  repairExpiredAttempts: protectedProcedure
    .input(z.object({ providerAccountId: id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      await accountFor(userId, input.providerAccountId);
      const repair = context.services?.repairExpiredProviderBudgets;
      if (!repair)
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "Provider repair service is unavailable",
        });
      await prisma.providerAuditEvent.create({
        data: {
          userId,
          providerAccountId: input.providerAccountId,
          action: "ACCOUNTING_REPAIR_REQUESTED",
          subjectId: input.providerAccountId,
        },
      });
      const repaired = await repair({ userId, providerAccountId: input.providerAccountId });
      return { repaired };
    }),
  rotateCredential: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const candidate = await prisma.providerCredential.findFirst({
        where: { id: input.id, userId },
        select: { id: true, providerAccountId: true },
      });
      if (!candidate) throw missing();
      return prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${candidate.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM provider_credential WHERE id = ${candidate.id} AND "userId" = ${userId} FOR UPDATE`;
          const row = await tx.providerCredential.findFirst({
            where: {
              id: candidate.id,
              userId,
              status: "ACTIVE",
              ProviderAccount: { deletedAt: null, currentCredentialId: candidate.id },
            },
          });
          if (!row) throw missing();
          const keyring = ring();
          const identity = {
            userId,
            providerAccountId: row.providerAccountId,
            credentialId: row.id,
            credentialType: row.credentialType,
            aadVersion: row.aadVersion,
          };
          const plaintext = decryptProviderCredential(
            {
              algorithm: row.algorithm as "AES-256-GCM",
              keyVersion: row.keyVersion,
              ciphertext: Buffer.from(row.ciphertext),
              nonce: Buffer.from(row.nonce),
              authTag: Buffer.from(row.authTag),
            },
            identity,
            keyring,
          );
          const encrypted = encryptProviderCredential(plaintext, identity, keyring);
          const changed = await tx.providerCredential.updateMany({
            where: { id: row.id, userId, status: "ACTIVE", keyVersion: row.keyVersion },
            data: encrypted,
          });
          if (changed.count !== 1) throw new ORPCError("CONFLICT");
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: row.providerAccountId,
              action: "CREDENTIAL_ROTATED",
              subjectId: row.id,
            },
          });
          return {
            id: row.id,
            keyVersion: encrypted.keyVersion,
            displaySuffix: encrypted.displaySuffix,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),
  testCredential: protectedProcedure
    .input(z.object({ providerAccountId: id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const account = await accountFor(userId, input.providerAccountId);
      const row = account.currentCredentialId
        ? await prisma.providerCredential.findFirst({
            where: { id: account.currentCredentialId, userId, status: "ACTIVE" },
          })
        : null;
      if (!row) throw missing();
      const secret = decryptProviderCredential(
        {
          algorithm: row.algorithm as "AES-256-GCM",
          keyVersion: row.keyVersion,
          ciphertext: Buffer.from(row.ciphertext),
          nonce: Buffer.from(row.nonce),
          authTag: Buffer.from(row.authTag),
        },
        {
          userId,
          providerAccountId: account.id,
          credentialId: row.id,
          credentialType: row.credentialType,
          aadVersion: row.aadVersion,
        },
        ring(),
      );
      let statusCode: number | null = null;
      let requestError: unknown;
      try {
        const providerAuth =
          row.credentialType === "BEARER"
            ? ({ type: "BEARER", token: secret } as const)
            : ({ type: "API_KEY", apiKey: secret } as const);
        const response = await providerHttpsRequest(
          account.baseUrl,
          { method: "GET", headers: { accept: "application/json" } },
          policy(),
          account.providerType === "anthropic" ? "anthropic" : "openai",
          providerAuth,
        );
        response.resume();
        statusCode = response.statusCode ?? null;
      } catch (error) {
        requestError = error;
      }
      const ok = requestError === undefined && (statusCode ?? 500) < 400;
      await prisma.$transaction(async (tx) => {
        // Match every credential lifecycle mutation's account-then-credential
        // lock order. The credential may have been revoked (or removed) while
        // the network request was in flight; that must not erase the attempt.
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${account.id} AND "userId" = ${userId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM provider_credential WHERE id = ${row.id} AND "userId" = ${userId} FOR UPDATE`;
        await tx.providerCredential.updateMany({
          where: { id: row.id, userId, status: "ACTIVE" },
          data: { lastUsedAt: new Date() },
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: account.id,
            action: "CREDENTIAL_TESTED",
            subjectId: row.id,
            metadata: { outcome: ok ? "SUCCESS" : "FAILURE", statusCode },
          },
        });
      }, providerWriteTransaction);
      if (requestError !== undefined)
        throw new ORPCError("BAD_GATEWAY", { message: redactProviderError(requestError) });
      return { ok, statusCode };
    }),
  listBudgetPolicies: protectedProcedure.handler(({ context }) => {
    enabled();
    return prisma.providerBudgetPolicy.findMany({
      where: { userId: context.session.user.id, ProviderAccount: { deletedAt: null } },
      include: { Rules: true },
    });
  }),
  createBudgetPolicy: protectedProcedure
    .input(
      z.object({
        scopeType: z.enum(["PROVIDER_ACCOUNT", "POOL_PROVIDER_MODEL"]),
        providerAccountId: id,
        poolId: id.nullable(),
        providerModelId: id.nullable(),
        active: z.boolean().default(false),
        rules: z.array(rule).min(1),
      }),
    )
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      if (
        (input.scopeType === "POOL_PROVIDER_MODEL") !==
        Boolean(input.poolId && input.providerModelId)
      )
        throw new ORPCError("BAD_REQUEST");
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${userId}:${input.providerAccountId}`}, 0))`;
        await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${input.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
        const account = await tx.providerAccount.findFirst({
          where: { id: input.providerAccountId, userId, deletedAt: null },
          select: { id: true },
        });
        if (!account) throw missing();
        if (input.providerModelId) {
          const model = await tx.providerModel.findFirst({
            where: {
              id: input.providerModelId,
              userId,
              providerAccountId: account.id,
              deletedAt: null,
              ProviderAccount: { deletedAt: null },
            },
            select: { id: true },
          });
          if (!model) throw missing();
        }
        if (input.poolId) {
          const pool = await tx.modelPool.findFirst({
            // Model pools are hard-deleted, so an owner-scoped re-read is the
            // liveness check after the provider-account lock is acquired.
            where: { id: input.poolId, userId },
            select: { id: true },
          });
          if (!pool) throw missing();
        }
        const row = await tx.providerBudgetPolicy.create({
          data: {
            userId,
            scopeType: input.scopeType,
            providerAccountId: input.providerAccountId,
            poolId: input.poolId,
            providerModelId: input.providerModelId,
            active: input.active,
            activatedAt: input.active ? new Date() : null,
            Rules: {
              create: input.rules.map((r) => ({
                ...r,
                limitValue: r.limitValue ? new Prisma.Decimal(r.limitValue) : null,
              })),
            },
          },
          include: { Rules: true },
        });
        await tx.providerAuditEvent.create({
          data: {
            userId,
            providerAccountId: input.providerAccountId,
            action: "BUDGET_CREATED",
            subjectId: row.id,
            metadata: budgetAuditMetadata(input.rules),
          },
        });
        return row;
      }, providerWriteTransaction);
    }),
  replaceBudgetPolicy: protectedProcedure
    .input(z.object({ id, active: z.boolean(), rules: z.array(rule).min(1) }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const current = await prisma.providerBudgetPolicy.findFirst({
        where: { id: input.id, userId },
      });
      if (!current) throw missing();
      return prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${userId}:${current.providerAccountId}`}, 0))`;
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${current.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM provider_budget_policy WHERE id = ${current.id} AND "userId" = ${userId} FOR UPDATE`;
          const locked = await tx.providerBudgetPolicy.findFirst({
            where: { id: current.id, userId, ProviderAccount: { deletedAt: null } },
          });
          if (!locked) throw missing();
          const latest = await tx.providerBudgetPolicy.findFirst({
            where: {
              userId,
              scopeType: locked.scopeType,
              providerAccountId: locked.providerAccountId,
              poolId: locked.poolId,
              providerModelId: locked.providerModelId,
            },
            orderBy: { version: "desc" },
            select: { id: true },
          });
          if (latest?.id !== locked.id)
            throw new ORPCError("CONFLICT", { message: "Budget policy version is stale" });
          if (locked.active) {
            await tx.providerBudgetPolicy.update({
              where: { id: locked.id },
              data: { active: false, deactivatedAt: new Date() },
            });
          }
          const row = await tx.providerBudgetPolicy.create({
            data: {
              userId,
              scopeType: locked.scopeType,
              providerAccountId: locked.providerAccountId,
              poolId: locked.poolId,
              providerModelId: locked.providerModelId,
              version: locked.version + 1,
              active: input.active,
              activatedAt: input.active ? new Date() : null,
              Rules: {
                create: input.rules.map((r) => ({
                  ...r,
                  limitValue: r.limitValue ? new Prisma.Decimal(r.limitValue) : null,
                })),
              },
            },
            include: { Rules: true },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: locked.providerAccountId,
              action: "BUDGET_UPDATED",
              subjectId: row.id,
              metadata: budgetAuditMetadata(input.rules, { replacesPolicyId: locked.id }),
            },
          });
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),
  deactivateBudgetPolicy: protectedProcedure
    .input(z.object({ id }))
    .handler(async ({ input, context }) => {
      enabled();
      const userId = context.session.user.id;
      const current = await prisma.providerBudgetPolicy.findFirst({
        where: { id: input.id, userId },
        select: { id: true, providerAccountId: true },
      });
      if (!current) throw missing();
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${userId}:${current.providerAccountId}`}, 0))`;
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id = ${current.providerAccountId} AND "userId" = ${userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM provider_budget_policy WHERE id = ${current.id} AND "userId" = ${userId} FOR UPDATE`;
          const locked = await tx.providerBudgetPolicy.findFirst({
            where: { id: current.id, userId, ProviderAccount: { deletedAt: null } },
          });
          if (!locked) throw missing();
          if (!locked.active) return;
          const changed = await tx.providerBudgetPolicy.updateMany({
            where: { id: locked.id, userId, active: true },
            data: { active: false, deactivatedAt: new Date() },
          });
          if (changed.count !== 1) throw new ORPCError("CONFLICT");
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: locked.providerAccountId,
              action: "BUDGET_DEACTIVATED",
              subjectId: current.id,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { success: true };
    }),
};
