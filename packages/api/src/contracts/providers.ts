/** Providers and spend caps. Every write here is human-only (cloud spend and provider keys). */
import { z } from "zod";
import {
  ATTEMPT_STATE,
  currencySchema,
  idSchema,
  isoDateSchema,
  MODEL_TYPE,
  moneySchema,
  nameSchema,
  noInputSchema,
  okSchema,
  PROVIDER_AUTH_TYPE,
  PROVIDER_CREDENTIAL_STATUS,
  PROVIDER_HEALTH,
  PROVIDER_PRICING_STATUS,
  pageInputShape,
  pageOf,
  USAGE_COST_CONFIDENCE,
} from "./common";
import { mutation, query } from "./procedure";

export const PROVIDER_TYPES = ["openrouter", "generic"] as const;

export const spendViewSchema = z
  .object({
    monthlyLimit: moneySchema.nullable(),
    currency: currencySchema,
    spentThisMonth: moneySchema,
    reservedNow: moneySchema,
  })
  .strict();

export const providerAccountViewSchema = z
  .object({
    id: idSchema,
    providerType: z.enum(PROVIDER_TYPES),
    label: z.string(),
    baseUrl: z.string(),
    authType: z.enum(PROVIDER_AUTH_TYPE),
    enabled: z.boolean(),
    allowDataCollection: z.boolean(),
    health: z.enum(PROVIDER_HEALTH),
    healthCheckedAt: isoDateSchema.nullable(),
    credential: z
      .object({
        id: idSchema,
        status: z.enum(PROVIDER_CREDENTIAL_STATUS),
        /** Last characters only; never the secret. */
        displaySuffix: z.string(),
        lastUsedAt: isoDateSchema.nullable(),
      })
      .strict()
      .nullable(),
    spend: spendViewSchema,
    createdAt: isoDateSchema,
  })
  .strict();

export const providerModelViewSchema = z
  .object({
    id: idSchema,
    providerAccountId: idSchema,
    upstreamModelId: z.string(),
    displayName: z.string().nullable(),
    type: z.enum(MODEL_TYPE),
    enabled: z.boolean(),
    health: z.enum(PROVIDER_HEALTH),
    contextWindow: z.number().int().nullable(),
    maxOutputTokens: z.number().int().nullable(),
    /** Active price per million tokens (input/output), when known. */
    price: z
      .object({ input: moneySchema, output: moneySchema, currency: currencySchema })
      .strict()
      .nullable(),
  })
  .strict();

export const pricingVersionViewSchema = z
  .object({
    id: idSchema,
    providerModelId: idSchema,
    version: z.string(),
    status: z.enum(PROVIDER_PRICING_STATUS),
    currency: currencySchema,
    confidence: z.enum(USAGE_COST_CONFIDENCE),
    pricing: z.record(z.string(), moneySchema),
    effectiveAt: isoDateSchema,
    activatedAt: isoDateSchema.nullable(),
    retiredAt: isoDateSchema.nullable(),
  })
  .strict();

const pricingInput = z
  .object({
    currency: currencySchema,
    /** Per million tokens: input, output, cacheRead, cacheWrite, reasoning, ... */
    pricing: z.record(z.string().regex(/^[a-zA-Z]{1,32}$/), moneySchema),
    effectiveAt: isoDateSchema.optional(),
  })
  .strict();

export const providersContract = {
  accounts: {
    list: query(
      "agent",
      noInputSchema,
      z.object({ accounts: z.array(providerAccountViewSchema) }).strict(),
      "Provider accounts (no secrets), health, this month's spend against the cap.",
      ["providers_get"],
    ),
    get: query(
      "session",
      z.object({ accountId: idSchema }).strict(),
      providerAccountViewSchema.extend({ models: z.array(providerModelViewSchema) }).strict(),
      "One provider account with its models.",
    ),
    create: mutation(
      "human",
      z
        .object({
          providerType: z.enum(PROVIDER_TYPES),
          label: nameSchema,
          baseUrl: z.string().url().max(2_048),
          authType: z.enum(PROVIDER_AUTH_TYPE),
          secret: z.string().min(1).max(4_096),
          allowDataCollection: z.boolean().default(false),
        })
        .strict(),
      providerAccountViewSchema,
      "Add a cloud account (disabled until enabled).",
    ),
    update: mutation(
      "human",
      z
        .object({
          accountId: idSchema,
          label: nameSchema.optional(),
          baseUrl: z.string().url().max(2_048).optional(),
        })
        .strict(),
      providerAccountViewSchema,
      "Rename or move a provider account.",
    ),
    delete: mutation(
      "human",
      z.object({ accountId: idSchema }).strict(),
      okSchema,
      "Delete a provider account.",
    ),
    setEnabled: mutation(
      "human",
      z.object({ accountId: idSchema, enabled: z.boolean() }).strict(),
      providerAccountViewSchema,
      "Turn a provider account on or off.",
    ),
    setDataCollection: mutation(
      "human",
      z.object({ accountId: idSchema, allow: z.boolean() }).strict(),
      providerAccountViewSchema,
      "OpenRouter data-collection consent.",
    ),
  },
  credentials: {
    replace: mutation(
      "human",
      z.object({ accountId: idSchema, secret: z.string().min(1).max(4_096) }).strict(),
      providerAccountViewSchema,
      "Replace the account's key.",
    ),
    revoke: mutation(
      "human",
      z.object({ credentialId: idSchema }).strict(),
      okSchema,
      "Revoke a key (the account stops working until replaced).",
    ),
    test: mutation(
      "human",
      z.object({ accountId: idSchema }).strict(),
      z
        .object({
          ok: z.boolean(),
          status: z.number().int().nullable(),
          detail: z.string().nullable(),
        })
        .strict(),
      "Probe the provider with the stored key.",
    ),
    reencrypt: mutation(
      "human",
      z.object({ accountId: idSchema.optional() }).strict(),
      z.object({ reencrypted: z.number().int() }).strict(),
      "Re-encrypt stored keys under the current key version.",
    ),
  },
  models: {
    list: query(
      "agent",
      z.object({ accountId: idSchema.optional() }).strict(),
      z.object({ models: z.array(providerModelViewSchema) }).strict(),
      "Provider models (type, context, price, enabled).",
      ["providers_get"],
    ),
    create: mutation(
      "human",
      z
        .object({
          accountId: idSchema,
          upstreamModelId: z.string().min(1).max(256),
          displayName: z.string().max(200).optional(),
          type: z.enum(MODEL_TYPE),
          contextWindow: z.number().int().positive().optional(),
          maxOutputTokens: z.number().int().positive().optional(),
        })
        .strict(),
      providerModelViewSchema,
      "Add a provider model (disabled until enabled).",
    ),
    update: mutation(
      "human",
      z
        .object({
          modelId: idSchema,
          displayName: z.string().max(200).nullable().optional(),
          enabled: z.boolean().optional(),
          contextWindow: z.number().int().positive().nullable().optional(),
          maxOutputTokens: z.number().int().positive().nullable().optional(),
        })
        .strict(),
      providerModelViewSchema,
      "Enable/disable or edit a provider model.",
    ),
    delete: mutation(
      "human",
      z.object({ modelId: idSchema }).strict(),
      okSchema,
      "Delete a provider model.",
    ),
  },
  pricing: {
    list: query(
      "session",
      z.object({ modelId: idSchema }).strict(),
      z.object({ versions: z.array(pricingVersionViewSchema) }).strict(),
      "Price versions of a provider model.",
    ),
    create: mutation(
      "human",
      pricingInput.extend({ modelId: idSchema }).strict(),
      pricingVersionViewSchema,
      "Add a draft price version.",
    ),
    activate: mutation(
      "human",
      z.object({ versionId: idSchema }).strict(),
      pricingVersionViewSchema,
      "Activate a draft price version.",
    ),
    retire: mutation(
      "human",
      z.object({ versionId: idSchema }).strict(),
      pricingVersionViewSchema,
      "Retire an active price version.",
    ),
    delete: mutation(
      "human",
      z.object({ versionId: idSchema }).strict(),
      okSchema,
      "Delete a draft price version.",
    ),
  },
  catalog: {
    search: query(
      "session",
      z
        .object({ query: z.string().trim().min(1).max(200), type: z.enum(MODEL_TYPE).optional() })
        .strict(),
      z
        .object({
          models: z.array(
            z
              .object({
                id: z.string(),
                name: z.string(),
                type: z.enum(MODEL_TYPE),
                contextWindow: z.number().int().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
      "Search the OpenRouter catalog (own-key equivalents, adding models).",
    ),
  },
  usage: {
    list: query(
      "session",
      z.object({ accountId: idSchema.optional(), ...pageInputShape }).strict(),
      pageOf(
        z
          .object({
            id: idSchema,
            createdAt: isoDateSchema,
            providerModelId: idSchema,
            poolId: idSchema.nullable(),
            inputTokens: z.number().int().nullable(),
            outputTokens: z.number().int().nullable(),
            cost: moneySchema.nullable(),
            currency: currencySchema.nullable(),
            confidence: z.enum(USAGE_COST_CONFIDENCE),
          })
          .strict(),
      ),
      "Cloud usage and cost rows.",
    ),
  },
  attempts: {
    list: query(
      "session",
      z.object({ accountId: idSchema.optional(), ...pageInputShape }).strict(),
      pageOf(
        z
          .object({
            id: idSchema,
            requestId: idSchema,
            createdAt: isoDateSchema,
            state: z.enum(ATTEMPT_STATE),
            providerModelId: idSchema.nullable(),
            httpStatusCode: z.number().int().nullable(),
            errorClass: z.string().nullable(),
          })
          .strict(),
      ),
      "Cloud attempts.",
    ),
  },
  spendCaps: {
    set: mutation(
      "human",
      z
        .object({
          accountId: idSchema,
          monthlyLimit: moneySchema,
          currency: currencySchema.default("USD"),
        })
        .strict(),
      spendViewSchema,
      "Set a provider account's monthly cap (share caps are set on the share).",
    ),
    clear: mutation(
      "human",
      z.object({ accountId: idSchema }).strict(),
      spendViewSchema,
      "Remove a provider account's monthly cap.",
    ),
  },
} as const;
