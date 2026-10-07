import { z } from "zod";
import { embeddingContractSchema } from "../lib/embedding-contract";
import { poolAdvancedPatchSchema, poolAdvancedViewSchema } from "./advanced";
import {
  actorRefSchema,
  confirmDeleteSchema,
  descriptionSchema,
  FALLBACK_MODE,
  idSchema,
  isoDateSchema,
  MEMBER_KIND,
  MEMBER_STATE,
  MODEL_TYPE,
  nameSchema,
  noInputSchema,
  noteSchema,
  okSchema,
  PRIORITY_CLASS,
  pageInputShape,
  pageOf,
  SIDECAR_INPUT,
  slugSchema,
  TARGET_HEALTH,
} from "./common";
import { mutation, query } from "./procedure";

// ── Model-name aliases ──

/**
 * A model name a harness sends (`gpt-4o`, `claude-sonnet-4-5`, `meta-llama/Llama-3.1-8B`): what
 * OpenAI-, Anthropic- and Hugging Face-style ids look like, without the `:external` variant
 * suffix or the `runtime:` test prefix.
 */
export const modelAliasNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/, "letters, digits and . _ : / @ + - only")
  .refine((name) => !/:external$/i.test(name), "the :external variant is added by callers")
  .refine((name) => !name.startsWith("runtime:"), "runtime: names are direct tests");

export const MODEL_ALIASES_MAX_PER_USER = 64;

export const modelAliasViewSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    poolId: idSchema,
    /** The pool's callable ID; null while you cannot use the pool (nothing of it is shown). */
    callableId: z.string().nullable(),
    apiKeyId: idSchema.nullable(),
    /** The key's name (null: every key). */
    apiKeyName: z.string().nullable(),
    /** False while the pool is not callable for you (share revoked, key not allowed it). */
    usable: z.boolean(),
  })
  .strict();

// ── Metric routing rules (same rules as 0.4-dev `metric-routing.ts`, JSON-schema friendly) ──

const metricNameSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
export const routingRuleSchema = z
  .object({
    /** A node gauge (`node.cpu.usagePercent`, ...), a node metric command value, or a reader signal. */
    metric: metricNameSchema,
    labels: z
      .record(metricNameSchema, metricNameSchema)
      .refine((labels) => !Object.hasOwn(labels, "__proto__"), "A label key is reserved.")
      .refine((labels) => Object.keys(labels).length <= 16, "At most 16 labels per rule.")
      .optional(),
    aggregate: z.enum(["max", "min", "avg"]).default("max"),
    op: z.enum([">", ">=", "<", "<="]),
    threshold: z.number().finite(),
    effect: z.enum(["full", "avoid"]),
    /** Only this member. */
    memberId: idSchema.nullable().optional(),
    /** Every member except this one. */
    excludeMemberId: idSchema.nullable().optional(),
  })
  .strict()
  .refine((rule) => !(rule.memberId && rule.excludeMemberId), {
    message: "Set memberId or excludeMemberId, not both.",
    path: ["excludeMemberId"],
  });
/** At most 16 per pool; replaces the pool's rule list. */
export const routingRulesSchema = z.array(routingRuleSchema).max(16);

// ── Views ──

/** What the member list shows; derived, never stored (§3.9). */
export const MEMBER_STATUS = [
  "serving",
  "starting",
  "unavailable",
  "disabled",
  "cloud_standby",
] as const;

export const poolMemberViewSchema = z
  .object({
    id: idSchema,
    kind: z.enum(MEMBER_KIND),
    state: z.enum(MEMBER_STATE),
    status: z.enum(MEMBER_STATUS),
    weight: z.number().int(),
    /** LOCAL: the served model and its runtime. */
    runtimeModelId: idSchema.nullable(),
    runtimeId: idSchema.nullable(),
    runtimeSlug: z.string().nullable(),
    upstreamModelId: z.string(),
    /** Contributed by a share holder (owner can remove; agents only tune weight/state). */
    shareId: idSchema.nullable(),
    contributorEmail: z.string().nullable(),
    /** CLOUD: provider model and try order. */
    providerModelId: idSchema.nullable(),
    cloudOrder: z.number().int().nullable(),
    health: z.enum(TARGET_HEALTH),
    live: z
      .object({
        instances: z.number().int(),
        running: z.number().int(),
        waiting: z.number().int(),
        p95LatencyMs: z.number().nullable(),
      })
      .strict(),
  })
  .strict();

export const poolSidecarViewSchema = z
  .object({
    input: z.enum(SIDECAR_INPUT),
    targetPoolId: idSchema,
    targetCallableId: z.string(),
    prompt: z.string().nullable(),
    timeoutMs: z.number().int().nullable(),
    maxAssets: z.number().int().nullable(),
  })
  .strict();

export const poolRoutingRuleViewSchema = z
  .object({
    id: idSchema,
    position: z.number().int(),
    rule: routingRuleSchema,
    createdAt: isoDateSchema,
  })
  .strict();

export const poolViewSchema = z
  .object({
    id: idSchema,
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    modelType: z.enum(MODEL_TYPE),
    /** `owner/pool`, and `owner/pool:external` when the cloud mode covers you. */
    callableIds: z.array(z.string()),
    owner: z.object({ userId: idSchema, slug: z.string(), you: z.boolean() }).strict(),
    routing: z
      .object({
        priorityClass: z.enum(PRIORITY_CLASS),
        concurrencyLimit: z.number().int().nullable(),
        keptSlots: z.number().int(),
        borrowKept: z.boolean(),
        ownHardwareOnly: z.boolean(),
      })
      .strict(),
    cloud: z
      .object({
        mode: z.enum(FALLBACK_MODE),
        embeddingContract: embeddingContractSchema.nullable(),
        paidWarmProtection: z.boolean(),
        ownKeyEquivalentModel: z.string().nullable(),
      })
      .strict(),
    sidecars: z.array(poolSidecarViewSchema),
    advanced: poolAdvancedViewSchema,
    rules: z.array(poolRoutingRuleViewSchema),
    members: z.array(poolMemberViewSchema),
    sharesCount: z.number().int(),
    /** "Hardware it runs on": nodes with an instance serving a LOCAL member now. */
    runsOn: z.array(
      z
        .object({
          nodeId: idSchema,
          slug: z.string(),
          mine: z.boolean(),
          instances: z.number().int(),
        })
        .strict(),
    ),
    /** Pool cards: last 24 h (agent tests excluded), 24 hourly request counts. */
    traffic24h: z
      .object({
        requests: z.number().int(),
        errors: z.number().int(),
        sparkline: z.array(z.number().int()).length(24),
      })
      .strict(),
  })
  .strict();

export const poolHistoryEntrySchema = z
  .object({
    id: idSchema,
    createdAt: isoDateSchema,
    actor: actorRefSchema,
    action: z.string(),
    before: z.unknown(),
    after: z.unknown(),
  })
  .strict();

// ── Inputs ──

const memberRefSchema = z.union([
  z.object({ runtimeModelId: idSchema }).strict(),
  z.object({ runtimeId: idSchema, model: z.string().min(1).max(256) }).strict(),
]);

const routingPatchSchema = z
  .object({
    priorityClass: z.enum(PRIORITY_CLASS).optional(),
    concurrencyLimit: z.number().int().min(1).max(100_000).nullable().optional(),
    keptSlots: z.number().int().min(0).max(10_000).optional(),
    borrowKept: z.boolean().optional(),
  })
  .strict();

const sidecarPatchSchema = z
  .object({
    input: z.enum(SIDECAR_INPUT),
    /** null removes the sidecar for this input. */
    targetPoolId: idSchema.nullable(),
    prompt: z.string().max(8_000).nullable().optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).nullable().optional(),
    maxAssets: z.number().int().min(1).max(64).nullable().optional(),
  })
  .strict();

// ── Procedures ──

export const poolsContract = {
  list: query(
    "agent",
    noInputSchema,
    z
      .object({
        pools: z.array(poolViewSchema),
        /** Pools shared with you (can use and/or can contribute). */
        sharedWithMe: z.array(
          z
            .object({
              poolId: idSchema,
              callableIds: z.array(z.string()),
              ownerEmail: z.string(),
              modelType: z.enum(MODEL_TYPE),
              canUse: z.boolean(),
              canContribute: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict(),
    "Your pools (full view) and pools shared with you.",
    ["pools_get"],
  ),
  get: query(
    "agent",
    z.object({ poolId: idSchema }).strict(),
    poolViewSchema,
    "One pool: routing, cloud (read-only for agents), sidecars, advanced with sources, members with live load.",
    ["pools_get"],
  ),
  history: {
    list: query(
      "agent",
      z.object({ poolId: idSchema, ...pageInputShape }).strict(),
      pageOf(poolHistoryEntrySchema),
      "Configuration changes of a pool.",
      ["pools_get"],
    ),
  },
  create: mutation(
    "agent",
    z
      .object({
        slug: slugSchema,
        name: nameSchema,
        description: descriptionSchema.optional(),
        type: z.enum(MODEL_TYPE),
        members: z.array(memberRefSchema).max(64).optional(),
        routing: routingPatchSchema.optional(),
        advanced: poolAdvancedPatchSchema.optional(),
        sidecars: z.array(sidecarPatchSchema).max(3).optional(),
        note: noteSchema.optional(),
      })
      .strict(),
    poolViewSchema,
    "Create a pool (Local only: cloud mode starts OFF).",
    ["pool_create"],
  ),
  update: mutation(
    "agent",
    z
      .object({
        poolId: idSchema,
        name: nameSchema.optional(),
        slug: slugSchema.optional(),
        description: descriptionSchema.nullable().optional(),
        members: z
          .object({
            add: z.array(memberRefSchema).max(64).optional(),
            remove: z.array(idSchema).max(64).optional(),
            set: z
              .array(
                z
                  .object({
                    memberId: idSchema,
                    weight: z.number().int().min(1).max(1_000).optional(),
                    state: z.enum(MEMBER_STATE).optional(),
                  })
                  .strict(),
              )
              .max(128)
              .optional(),
          })
          .strict()
          .optional(),
        /** Ordered; only provider models a person enabled qualify. Replaces the cloud list. */
        cloudMembers: z
          .array(z.object({ providerModelId: idSchema }).strict())
          .max(16)
          .optional(),
        routing: routingPatchSchema.optional(),
        cloud: z
          .object({ embeddingContract: embeddingContractSchema.nullable().optional() })
          .strict()
          .optional(),
        sidecars: z.array(sidecarPatchSchema).max(3).optional(),
        advanced: poolAdvancedPatchSchema
          .extend({ rules: routingRulesSchema.optional() })
          .strict()
          .optional(),
        note: noteSchema.optional(),
      })
      .strict(),
    poolViewSchema,
    "Edit a pool. Never: cloud mode, paid warm protection, own-key consent, own-hardware-only (human_only).",
    ["pool_update"],
  ),
  aliases: {
    list: query(
      "agent",
      noInputSchema,
      z.object({ aliases: z.array(modelAliasViewSchema) }).strict(),
      "Your model-name aliases (for harnesses with hard-coded model names).",
      ["pools_get"],
    ),
    set: mutation(
      "agent",
      z
        .object({
          name: modelAliasNameSchema,
          /** A pool you may use (own, or shared with you with can use). */
          poolId: idSchema,
          /** Only for this API key of yours (it wins over an alias for every key). */
          apiKeyId: idSchema.nullable().optional(),
          note: noteSchema.optional(),
        })
        .strict(),
      modelAliasViewSchema,
      "Point a model name callers send at one of your callable pools (creates or moves it).",
      ["pool_update"],
    ),
    delete: mutation(
      "agent",
      z.object({ aliasId: idSchema, note: noteSchema.optional() }).strict(),
      okSchema,
      "Remove one of your model-name aliases.",
      ["pool_update"],
    ),
  },
  delete: mutation(
    "agent",
    z.object({ poolId: idSchema, confirm: confirmDeleteSchema.optional() }).strict(),
    okSchema,
    "Delete a pool with its shares, share caps, contributed members, API-key entries and sidecar links.",
    ["pool_delete"],
  ),
  cloud: {
    setMode: mutation(
      "human",
      z.object({ poolId: idSchema, mode: z.enum(FALLBACK_MODE) }).strict(),
      poolViewSchema,
      "Who may make this pool spend cloud money (callers still opt in with :external).",
    ),
    setPaidWarmProtection: mutation(
      "human",
      z.object({ poolId: idSchema, enabled: z.boolean() }).strict(),
      poolViewSchema,
      "Paid warm-cache protection on cloud members.",
    ),
    setOwnKeyEquivalent: mutation(
      "human",
      z.object({ poolId: idSchema, model: z.string().min(1).max(256).nullable() }).strict(),
      poolViewSchema,
      "Consent that share holders may use their own provider key for this OpenRouter model (null withdraws).",
    ),
  },
  routing: {
    setOwnHardwareOnly: mutation(
      "human",
      z.object({ poolId: idSchema, enabled: z.boolean() }).strict(),
      poolViewSchema,
      "Route only to your own runtimes; contributed members stay listed but unused.",
    ),
  },
  members: {
    addContributed: mutation(
      "agent",
      z
        .object({ poolId: idSchema, runtimeModelId: idSchema, note: noteSchema.optional() })
        .strict(),
      poolMemberViewSchema,
      "A share holder with can-contribute adds one of THEIR OWN served models (anyone else's: not_your_runtime).",
      ["pool_update"],
    ),
    removeContributed: mutation(
      "agent",
      z.object({ memberId: idSchema, note: noteSchema.optional() }).strict(),
      okSchema,
      "The contributor (own members only) or the pool owner removes a contributed member.",
      ["pool_update"],
    ),
  },
  rules: {
    delete: mutation(
      "human",
      z.object({ ruleId: idSchema }).strict(),
      okSchema,
      "Delete a metric routing rule (agents write rules through pool_update.advanced.rules).",
    ),
  },
} as const;
