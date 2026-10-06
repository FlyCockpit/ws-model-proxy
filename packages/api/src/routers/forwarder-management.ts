import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { acquireFences, fenceOwners, fences } from "@ws-model-proxy/db/capacity-lock-order";
import { env } from "@ws-model-proxy/env/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  assertEffectiveContextPolicy,
  assertModelPoolCapacityPolicy,
  GUARDED_CREATE_POLICY_FIELDS,
} from "../lib/capacity-policy-safety";
import {
  type ContextWindowSeedDependent,
  declaredContextWindow,
} from "../lib/declared-context-window";
import { resolveEffectiveCapabilityMetadata } from "../lib/openai-compatible-capabilities";
import {
  assertProviderEgressReleaseGate,
  poolFallbackChangeSource,
  recordPoolFallbackAudit,
} from "../lib/pool-fallback-settings";
import {
  assertRecommendedSurfaceServable,
  discoveredModelSurfaceCapabilities,
  providerModelSurfaceCapabilities,
} from "../lib/pool-recommended-surface";
import { runSerializableCapacityCreationTransaction } from "../lib/serializable-transaction";
import { modelApiSurfaces } from "../lib/surface-capabilities";
import { cliDeviceProcedures } from "./forwarder-cli-devices";
import { poolMemberProcedures } from "./forwarder-pool-members";
import { poolProcedures, seedDeclaredContextWindows } from "./forwarder-pools";
import { poolSelect, serializePool } from "./forwarder-serializers";
import {
  assertConcurrencyPolicyWithinHardLimit,
  assertLossyDeveloperRoleCollapseRequiresAdaptation,
  assertPoolSlugAvailable,
  idSchema,
  poolNameSchema,
  poolSlugSchema,
} from "./forwarder-shared";
import { metricRoutingProcedures } from "./metric-routing";

export {
  assertPoolSlugAvailable,
  resolvePoolProtectionShare,
} from "./forwarder-shared";

let guardedSetupTestFailure: (() => void) | undefined;

export function setGuardedSetupTestFailureInjector(injector: (() => void) | undefined) {
  if (env.NODE_ENV !== "test") throw new Error("Guarded setup failure injection is test-only.");
  guardedSetupTestFailure = injector;
}

const guardedPoolProcedures = {
  listGuardedOverflowCandidates: protectedProcedure.handler(async ({ context }) => {
    const now = new Date();
    const rows = await prisma.providerModel.findMany({
      where: {
        userId: context.session.user.id,
        enabled: true,
        deletedAt: null,
        ProviderAccount: {
          enabled: true,
          deletedAt: null,
          CurrentCredential: { status: "ACTIVE" },
        },
        PricingVersions: {
          some: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
        },
      },
      select: {
        id: true,
        upstreamModelId: true,
        displayName: true,
        nativeCapabilities: true,
        capabilityMetadata: true,
        contextWindow: true,
        concurrencyLimit: true,
        ProviderAccount: { select: { id: true, label: true, providerType: true } },
        PricingVersions: {
          where: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
          orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { id: true, version: true, currency: true },
        },
      },
      orderBy: [{ ProviderAccount: { label: "asc" } }, { upstreamModelId: "asc" }],
    });
    return rows.flatMap((row) => {
      const pricing = row.PricingVersions[0];
      return pricing
        ? [
            {
              id: row.id,
              upstreamModelId: row.upstreamModelId,
              displayName: row.displayName,
              nativeCapabilities: row.nativeCapabilities,
              capabilityMetadata: row.capabilityMetadata,
              contextWindow: row.contextWindow,
              concurrencyLimit: row.concurrencyLimit,
              providerAccount: row.ProviderAccount,
              pricing,
            },
          ]
        : [];
    });
  }),
  createGuardedModelPool: protectedProcedure
    .input(
      (() => {
        const positiveDecimal = z
          .string()
          .regex(/^\d+(?:\.\d{1,9})?$/)
          .refine((value) => new Prisma.Decimal(value).greaterThan(0));
        const integerRule = (maximum: number) =>
          z.discriminatedUnion("mode", [
            z.object({ mode: z.literal("UNLIMITED"), limitValue: z.null() }),
            z.object({
              mode: z.literal("LIMITED"),
              limitValue: z.number().int().min(1).max(maximum),
            }),
          ]);
        const spendRule = z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("UNLIMITED"), limitValue: z.null() }),
          z.object({ mode: z.literal("LIMITED"), limitValue: positiveDecimal }),
        ]);
        return z
          .object({
            slug: poolSlugSchema,
            name: poolNameSchema,
            localModelIds: z.array(idSchema).max(64),
            recommendedSurface: z.enum(modelApiSurfaces),
            memberConcurrencyLimit: z.number().int().min(1).max(10_000),
            memberContextCeiling: z.number().int().min(1).max(100_000_000).nullable().default(null),
            reservedSlots: z.number().int().min(0).max(10_000),
            localWaitBudgetMs: z.number().int().min(0).max(600_000),
            advanced: z
              .object({
                physicalCountStrategy: z.enum([
                  "TOKENIZER",
                  "TEMPLATE_AWARE",
                  "ENGINE_REPORTED",
                  "CONSERVATIVE_ESTIMATE",
                  "CALIBRATED_ESTIMATE",
                ]),
                contextMargin: z.number().int().min(0).max(10_000_000),
                borrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
                protocolAdaptationEnabled: z.boolean(),
                allowLossyDeveloperRoleCollapse: z.boolean(),
                affinity: z.object({
                  enabled: z.boolean(),
                  ttlSeconds: z.number().int().min(60).max(604_800),
                  maxRecords: z.number().int().min(100).max(100_000),
                  prefixWeight: z.number().int().min(0).max(10_000),
                  conversationWeight: z.number().int().min(0).max(10_000),
                  confirmedCacheWeight: z.number().int().min(0).max(10_000),
                  loadPenaltyWeight: z.number().int().min(0).max(10_000),
                  residencyWeight: z.number().int().min(0).max(10_000).optional(),
                }),
                memberOverrides: z
                  .array(
                    z.object({
                      discoveredModelId: idSchema,
                      concurrency: integerRule(10_000),
                      reservedSlots: z.number().int().min(0).max(10_000),
                      borrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
                      waitBudget: integerRule(600_000),
                      contextCeiling: z.union([
                        z.object({ mode: z.literal("INHERIT"), limitValue: z.null() }),
                        integerRule(100_000_000),
                      ]),
                      contextMargin: z.number().int().min(0).max(10_000_000),
                    }),
                  )
                  .max(64),
              })
              .optional(),
            providerModels: z
              .array(
                z.object({
                  providerModelId: idSchema,
                  tier: z.enum(["PRIMARY", "PUBLIC_OVERFLOW"]).default("PUBLIC_OVERFLOW"),
                  concurrencyLimit: z.number().int().min(1).max(10_000),
                  dailySpendLimit: z.string(),
                  budgetRules: z
                    .object({
                      concurrency: integerRule(10_000),
                      tokensPerAttempt: integerRule(100_000_000_000),
                      tokensPerDay: integerRule(100_000_000_000),
                      tokensPerMonth: integerRule(100_000_000_000),
                      tokensLifetime: integerRule(100_000_000_000),
                      spendPerDay: spendRule,
                      spendPerMonth: spendRule,
                    })
                    .optional(),
                }),
              )
              .max(32)
              .default([]),
          })
          .superRefine((input, ctx) => {
            if (input.localModelIds.length + input.providerModels.length === 0) {
              ctx.addIssue({
                code: "custom",
                path: ["localModelIds"],
                message: "Select at least one local or provider target",
              });
            }
            if (input.reservedSlots > input.memberConcurrencyLimit) {
              ctx.addIssue({
                code: "custom",
                path: ["reservedSlots"],
                message: "Reserved slots exceed member concurrency",
              });
            }
            for (const [index, provider] of input.providerModels.entries()) {
              if (provider.tier === "PRIMARY")
                ctx.addIssue({
                  code: "custom",
                  path: ["providerModels", index, "tier"],
                  message:
                    "Provider models can only be external fallback (PUBLIC_OVERFLOW) members; plain pool names never leave the deployment.",
                });
            }
            if (new Set(input.localModelIds).size !== input.localModelIds.length) {
              ctx.addIssue({
                code: "custom",
                path: ["localModelIds"],
                message: "Duplicate local model",
              });
            }
            if (
              new Set(input.providerModels.map((item) => item.providerModelId)).size !==
              input.providerModels.length
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["providerModels"],
                message: "Duplicate provider model",
              });
            }
            if (
              input.advanced &&
              new Set(input.advanced.memberOverrides.map((item) => item.discoveredModelId)).size !==
                input.advanced.memberOverrides.length
            ) {
              ctx.addIssue({
                code: "custom",
                path: ["advanced", "memberOverrides"],
                message: "Duplicate local member override",
              });
            }
            for (const [index, provider] of input.providerModels.entries()) {
              if (
                !provider.budgetRules &&
                !positiveDecimal.safeParse(provider.dailySpendLimit).success
              )
                ctx.addIssue({
                  code: "custom",
                  path: ["providerModels", index, "dailySpendLimit"],
                  message: "Legacy guarded setup requires a positive daily spend limit",
                });
            }
          });
      })(),
    )
    .handler(async ({ input, context }) => {
      if (input.providerModels.length > 0)
        assertProviderEgressReleaseGate("PROVIDER_EGRESS_DISABLED");
      assertLossyDeveloperRoleCollapseRequiresAdaptation(
        {
          protocolAdaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
          allowLossyDeveloperRoleCollapse: input.advanced?.allowLossyDeveloperRoleCollapse ?? false,
        },
        "LOSSY_COLLAPSE_REQUIRES_ADAPTATION",
      );
      assertModelPoolCapacityPolicy(
        {
          concurrencyLimit: input.memberConcurrencyLimit,
          reservedSlots: input.reservedSlots,
          contextCeiling: input.memberContextCeiling,
          contextMargin: input.advanced?.contextMargin,
        },
        "POOL_POLICY_INVALID",
        GUARDED_CREATE_POLICY_FIELDS,
      );
      const userId = context.session.user.id;
      await assertPoolSlugAvailable(input.slug, userId, undefined, {
        invalid: "SLUG_INVALID",
        taken: "SLUG_TAKEN",
      });
      const now = new Date();
      return runSerializableCapacityCreationTransaction(async (tx) => {
        // Writer class M: the owner fence first (@ws-model-proxy/db/capacity-lock-order).
        await fenceOwners(tx, [userId]);
        const localModels = await tx.discoveredModel.findMany({
          where: {
            id: { in: input.localModelIds },
            userId,
            published: true,
            Endpoint: { published: true },
          },
          select: {
            id: true,
            upstreamModelId: true,
            capabilityOverrideMode: true,
            capabilityOverrides: true,
            capabilityOverrideMetadata: true,
            Endpoint: {
              select: { capabilityMetadata: true, defaultCapabilities: true },
            },
          },
        });
        if (localModels.length !== input.localModelIds.length) {
          throw new ORPCError("NOT_FOUND", {
            message: "A selected local model is unavailable",
            data: { reason: "LOCAL_MODEL_UNAVAILABLE" },
          });
        }
        const providerIds = input.providerModels.map((item) => item.providerModelId);
        const hasPublicOverflow = input.providerModels.some(
          (item) => item.tier === "PUBLIC_OVERFLOW",
        );
        const providers = providerIds.length
          ? await tx.providerModel.findMany({
              where: {
                id: { in: providerIds },
                userId,
                enabled: true,
                deletedAt: null,
                ProviderAccount: {
                  enabled: true,
                  deletedAt: null,
                  CurrentCredential: { status: "ACTIVE" },
                },
              },
              select: {
                id: true,
                providerAccountId: true,
                upstreamModelId: true,
                contextWindow: true,
                concurrencyLimit: true,
                nativeCapabilities: true,
                PricingVersions: {
                  where: { status: "ACTIVE", retiredAt: null, effectiveAt: { lte: now } },
                  orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
                  take: 1,
                  select: { id: true, currency: true },
                },
              },
            })
          : [];
        if (
          providers.length !== providerIds.length ||
          providers.some((row) => !row.PricingVersions[0])
        ) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message: "A selected provider is not ready for guarded routing",
            data: { reason: "PROVIDER_NOT_READY" },
          });
        }
        const primaryProviderIds = new Set(
          input.providerModels
            .filter((item) => item.tier === "PRIMARY")
            .map((item) => item.providerModelId),
        );
        // The recommended API is an operator choice: any surface that every
        // primary member can serve — natively or via protocol adaptation — is
        // accepted, not only the top-ranked one. An empty primary set (a
        // provider-only PUBLIC_OVERFLOW pool) accepts any surface. The
        // selectability contract is shared with the update path via
        // assertRecommendedSurfaceServable.
        assertRecommendedSurfaceServable({
          override: input.recommendedSurface,
          members: [
            ...localModels.map((model) => ({
              tier: "PRIMARY" as const,
              capabilities: discoveredModelSurfaceCapabilities(model),
            })),
            ...providers.map((provider) => ({
              tier: primaryProviderIds.has(provider.id) ? ("PRIMARY" as const) : "PUBLIC_OVERFLOW",
              capabilities: providerModelSurfaceCapabilities(provider.nativeCapabilities),
            })),
          ],
          adaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
        });
        const localTargets = await tx.executionTarget.findMany({
          where: { userId, discoveredModelId: { in: input.localModelIds } },
          select: {
            id: true,
            discoveredModelId: true,
            inferenceCapacityId: true,
            InferenceCapacity: {
              select: { physicalMaxContext: true, hardConcurrencyLimit: true },
            },
          },
        });
        if (
          localTargets.length !== localModels.length ||
          localTargets.some((target) => !target.inferenceCapacityId)
        ) {
          throw new ORPCError("PRECONDITION_FAILED", {
            message:
              "Every selected local model must already have an explicitly assigned physical capacity.",
            data: { reason: "LOCAL_CAPACITY_REQUIRED" },
          });
        }
        const declaredContextByModelId = new Map(
          localModels.map((model) => [
            model.id,
            declaredContextWindow(
              resolveEffectiveCapabilityMetadata({
                capabilityOverrideMode: model.capabilityOverrideMode,
                capabilityOverrideMetadata: model.capabilityOverrideMetadata,
                endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
              }),
            ),
          ]),
        );
        const memberOverrideByModelId = new Map(
          input.advanced?.memberOverrides.map((override) => [
            override.discoveredModelId,
            override,
          ]) ?? [],
        );
        if (
          memberOverrideByModelId.size > 0 &&
          [...memberOverrideByModelId.keys()].some(
            (modelId) => !input.localModelIds.includes(modelId),
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A member override does not belong to a selected local model.",
            data: { reason: "MEMBER_OVERRIDE_MISMATCH" },
          });
        }
        for (const target of localTargets) {
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          assertConcurrencyPolicyWithinHardLimit(
            {
              hardLimit: target.InferenceCapacity?.hardConcurrencyLimit,
              poolLimit: input.memberConcurrencyLimit,
              poolReserved: input.reservedSlots,
              memberMode: override?.concurrency.mode,
              memberLimit:
                override?.concurrency.mode === "LIMITED" ? override.concurrency.limitValue : null,
              memberReserved: override?.reservedSlots,
            },
            {
              reservedExceeds: "RESERVED_EXCEEDS_CONCURRENCY",
              reservedExceedsPhysical: "RESERVED_EXCEEDS_PHYSICAL",
              concurrencyExceedsPhysical: "CONCURRENCY_EXCEEDS_PHYSICAL",
            },
            GUARDED_CREATE_POLICY_FIELDS,
          );
          if (!override) continue;
          if (
            override.concurrency.mode === "LIMITED" &&
            override.reservedSlots > override.concurrency.limitValue
          ) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Reserved slots exceed a member concurrency override.",
              data: { reason: "RESERVED_EXCEEDS_CONCURRENCY" },
            });
          }
        }
        // Stable mutation order for mixed local/provider setup: identity
        // fences -> capacity-policy fences, all before the first row lock or
        // write; then provider account rows -> provider model rows (F-LO1:
        // the account before the model, the order every provider writer and
        // the provider health runtime use) -> target, capacity, member and
        // budget writes, whose foreign-key checks re-enter those rows.
        const orderedProviders = [...providers].sort((left, right) =>
          left.id.localeCompare(right.id),
        );
        const existingProviderTargets = orderedProviders.length
          ? await tx.executionTarget.findMany({
              where: { providerModelId: { in: orderedProviders.map((provider) => provider.id) } },
              select: { id: true },
            })
          : [];
        const seedCapacityIds = [
          ...new Set(
            localTargets.flatMap((target) =>
              target.inferenceCapacityId &&
              target.discoveredModelId &&
              declaredContextByModelId.get(target.discoveredModelId) != null
                ? [target.inferenceCapacityId]
                : [],
            ),
          ),
        ];
        const targetsSharingCandidateCapacity =
          seedCapacityIds.length > 0
            ? await tx.executionTarget.findMany({
                where: { userId, inferenceCapacityId: { in: seedCapacityIds } },
                select: { id: true },
              })
            : [];
        // A provider target this transaction creates is new, so it needs no
        // policy fence; every existing target it changes or attaches has one.
        const policyLockTargetIds = new Set([
          ...localTargets.map((target) => target.id),
          ...existingProviderTargets.map((target) => target.id),
          ...targetsSharingCandidateCapacity.map((target) => target.id),
        ]);
        await acquireFences(tx, [
          ...providers.map((provider) => fences.targetIdentity(`provider-model:${provider.id}`)),
          ...[...policyLockTargetIds].map((targetId) => fences.capacityPolicy(targetId)),
        ]);
        const providerAccountIds = [
          ...new Set(providers.map((provider) => provider.providerAccountId)),
        ].sort();
        if (providerAccountIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM provider_account WHERE id IN (${Prisma.join(
            providerAccountIds,
          )}) AND "userId" = ${userId} ORDER BY id FOR KEY SHARE`;
          await tx.$queryRaw`SELECT id FROM provider_model WHERE id IN (${Prisma.join(
            orderedProviders.map((provider) => provider.id),
          )}) AND "userId" = ${userId} ORDER BY id FOR KEY SHARE`;
        }
        const providerTargets = await Promise.all(
          orderedProviders.map((provider) =>
            tx.executionTarget.upsert({
              where: { providerModelId: provider.id },
              update: {},
              create: {
                userId,
                kind: "PROVIDER_MODEL",
                providerModelId: provider.id,
              },
              select: { id: true, providerModelId: true, inferenceCapacityId: true },
            }),
          ),
        );
        const seedCandidates = new Map<string, number>();
        for (const target of localTargets) {
          const declared = target.discoveredModelId
            ? declaredContextByModelId.get(target.discoveredModelId)
            : null;
          if (target.inferenceCapacityId && declared != null) {
            // A shared runtime can be declared by several models. The largest
            // declared window is the only candidate that cannot tighten one
            // model relative to another; policy admissibility is checked below.
            seedCandidates.set(
              target.inferenceCapacityId,
              Math.max(seedCandidates.get(target.inferenceCapacityId) ?? 0, declared),
            );
          }
        }
        for (const target of providerTargets) policyLockTargetIds.add(target.id);
        const additionalDependentsByCapacityId = new Map<string, ContextWindowSeedDependent[]>();
        for (const target of localTargets) {
          if (!target.inferenceCapacityId) continue;
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          const dependent: ContextWindowSeedDependent = {
            kind: "member",
            contextCeilingMode: override?.contextCeiling.mode ?? "INHERIT",
            contextCeiling:
              override?.contextCeiling.mode === "LIMITED"
                ? override.contextCeiling.limitValue
                : null,
            contextMargin:
              override && override.contextCeiling.mode !== "INHERIT"
                ? override.contextMargin
                : null,
            poolContextCeiling: input.memberContextCeiling,
            poolContextMargin: input.advanced?.contextMargin ?? 0,
          };
          const dependents = additionalDependentsByCapacityId.get(target.inferenceCapacityId);
          if (dependents) dependents.push(dependent);
          else additionalDependentsByCapacityId.set(target.inferenceCapacityId, [dependent]);
        }
        const seededPhysicalByCapacityId = await seedDeclaredContextWindows({
          tx,
          userId,
          candidates: seedCandidates,
          lockedExecutionTargetIds: policyLockTargetIds,
          additionalDependentsByCapacityId,
        });
        for (const target of localTargets) {
          const override = target.discoveredModelId
            ? memberOverrideByModelId.get(target.discoveredModelId)
            : undefined;
          const physicalMaximum =
            target.inferenceCapacityId && seededPhysicalByCapacityId.has(target.inferenceCapacityId)
              ? seededPhysicalByCapacityId.get(target.inferenceCapacityId)
              : target.InferenceCapacity?.physicalMaxContext;
          assertEffectiveContextPolicy(
            {
              physicalMaxContext: physicalMaximum,
              poolCeiling: input.memberContextCeiling,
              poolMargin: input.advanced?.contextMargin ?? 0,
              memberMode: override?.contextCeiling.mode,
              memberCeiling:
                override?.contextCeiling.mode === "LIMITED"
                  ? override.contextCeiling.limitValue
                  : null,
              memberMargin:
                override && override.contextCeiling.mode !== "INHERIT"
                  ? override.contextMargin
                  : null,
            },
            {
              marginExceedsCeiling: "CONTEXT_MARGIN_EXCEEDS_CEILING",
              exceedsPhysical: "CONTEXT_EXCEEDS_PHYSICAL",
            },
            GUARDED_CREATE_POLICY_FIELDS,
          );
        }
        if (
          providers.some(
            (provider) =>
              primaryProviderIds.has(provider.id) &&
              provider.contextWindow != null &&
              input.memberContextCeiling != null &&
              input.memberContextCeiling + (input.advanced?.contextMargin ?? 0) >
                provider.contextWindow,
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Member context exceeds a selected provider's context window.",
            data: { reason: "PROVIDER_CONTEXT_EXCEEDED" },
          });
        }
        for (const provider of providers) {
          assertConcurrencyPolicyWithinHardLimit(
            {
              hardLimit: provider.concurrencyLimit,
              poolLimit: input.memberConcurrencyLimit,
              poolReserved: input.reservedSlots,
            },
            {
              reservedExceeds: "RESERVED_EXCEEDS_CONCURRENCY",
              reservedExceedsPhysical: "RESERVED_EXCEEDS_PHYSICAL",
              concurrencyExceedsPhysical: "CONCURRENCY_EXCEEDS_PHYSICAL",
            },
            GUARDED_CREATE_POLICY_FIELDS,
          );
        }
        const pool = await tx.modelPool.create({
          data: {
            userId,
            slug: input.slug,
            name: input.name,
            protocolAdaptationEnabled: input.advanced?.protocolAdaptationEnabled ?? false,
            allowLossyDeveloperRoleCollapse:
              input.advanced?.allowLossyDeveloperRoleCollapse ?? false,
            // Fallback on only when external members are configured. Callers
            // still opt in per request with `owner/pool:external`.
            fallbackEnabled: hasPublicOverflow,
            recommendedSurfaceOverride: input.recommendedSurface,
            capacityPriority: 16,
            capacityConcurrencyLimit: input.memberConcurrencyLimit,
            capacityReservedSlots: input.reservedSlots,
            capacityWaitBudgetMs: input.localWaitBudgetMs,
            capacityContextCeiling: input.memberContextCeiling,
            capacityContextMargin: input.advanced?.contextMargin ?? 0,
            capacityBorrowPolicy: input.advanced?.borrowPolicy ?? "WHEN_IDLE",
            // Cache-affinity routing is ON by default for new guarded pools so
            // identical follow-up requests stick to the warm member.
            affinityEnabled: input.advanced?.affinity.enabled ?? true,
            affinityTtlSeconds: input.advanced?.affinity.ttlSeconds ?? 3600,
            affinityMaxRecords: input.advanced?.affinity.maxRecords ?? 10_000,
            affinityPrefixWeight: input.advanced?.affinity.prefixWeight ?? 100,
            affinityConversationWeight: input.advanced?.affinity.conversationWeight ?? 150,
            affinityConfirmedCacheWeight: input.advanced?.affinity.confirmedCacheWeight ?? 250,
            affinityLoadPenaltyWeight: input.advanced?.affinity.loadPenaltyWeight ?? 100,
            affinityResidencyWeight: input.advanced?.affinity.residencyWeight ?? 100,
          },
          select: { id: true },
        });
        if (input.advanced) {
          await tx.inferenceCapacity.updateMany({
            where: {
              userId,
              id: {
                in: [
                  ...new Set(localTargets.flatMap((target) => target.inferenceCapacityId ?? [])),
                ],
              },
            },
            data: { countStrategy: input.advanced.physicalCountStrategy },
          });
        }
        const localTargetByModelId = new Map(
          localTargets.map((target) => [target.discoveredModelId, target]),
        );
        for (const model of localModels) {
          const target = localTargetByModelId.get(model.id)!;
          const override = memberOverrideByModelId.get(model.id);
          await tx.poolMember.create({
            data: {
              poolId: pool.id,
              discoveredModelId: model.id,
              executionTargetId: target.id,
              tier: "PRIMARY",
              weight: 1,
              ...(override
                ? {
                    capacityConcurrencyMode: override.concurrency.mode,
                    capacityConcurrencyLimit:
                      override.concurrency.mode === "LIMITED"
                        ? override.concurrency.limitValue
                        : null,
                    capacityReservedSlots: override.reservedSlots,
                    capacityBorrowPolicy: override.borrowPolicy,
                    capacityWaitBudgetMode: override.waitBudget.mode,
                    capacityWaitBudgetMs:
                      override.waitBudget.mode === "LIMITED"
                        ? override.waitBudget.limitValue
                        : null,
                    capacityContextCeilingMode: override.contextCeiling.mode,
                    capacityContextCeiling:
                      override.contextCeiling.mode === "LIMITED"
                        ? override.contextCeiling.limitValue
                        : null,
                    capacityContextMargin:
                      override.contextCeiling.mode === "INHERIT" ? null : override.contextMargin,
                  }
                : {
                    capacityContextCeilingMode: "INHERIT",
                    capacityContextCeiling: null,
                    capacityContextMargin: null,
                  }),
            },
          });
        }
        const providerById = new Map(providers.map((provider) => [provider.id, provider]));
        const providerTargetByModelId = new Map(
          providerTargets.map((target, index) => [orderedProviders[index]?.id, target]),
        );
        let publicOrder = 0;
        for (const protection of input.providerModels) {
          const provider = providerById.get(protection.providerModelId);
          if (!provider) throw new ORPCError("PRECONDITION_FAILED");
          const capacity = await tx.inferenceCapacity.upsert({
            where: {
              userId_runtimeIdentityKey: {
                userId,
                runtimeIdentityKey: `provider-model:${provider.id}`,
              },
            },
            update: {},
            create: {
              userId,
              label: `Provider model ${provider.id}`,
              runtimeIdentityKey: `provider-model:${provider.id}`,
              runtimeModel: provider.upstreamModelId,
              hardConcurrencyLimit: provider.concurrencyLimit,
              // Seeded from the user-configured provider model limit (null = unlimited).
              hardConcurrencyLimitSource: "USER",
              physicalMaxContext: provider.contextWindow,
              countStrategy: "CONSERVATIVE_ESTIMATE",
            },
            select: { id: true },
          });
          const target = providerTargetByModelId.get(provider.id);
          if (!target) throw new ORPCError("PRECONDITION_FAILED");
          if (!target.inferenceCapacityId)
            await tx.executionTarget.updateMany({
              where: { id: target.id, inferenceCapacityId: null, capacityAssignmentSource: "AUTO" },
              data: { inferenceCapacityId: capacity.id, capacityAssignmentSource: "OWNER" },
            });
          await tx.poolMember.create({
            data: {
              poolId: pool.id,
              executionTargetId: target.id,
              tier: protection.tier,
              publicOrder: protection.tier === "PUBLIC_OVERFLOW" ? publicOrder++ : null,
              weight: protection.tier === "PRIMARY" ? 1 : 0,
            },
          });
          const budget = await tx.providerBudgetPolicy.create({
            data: {
              userId,
              scopeType: "POOL_PROVIDER_MODEL",
              providerAccountId: provider.providerAccountId,
              poolId: pool.id,
              providerModelId: provider.id,
              active: true,
              activatedAt: now,
              Rules: {
                create: (() => {
                  const rules = protection.budgetRules;
                  if (!rules)
                    return [
                      {
                        metric: "CONCURRENCY" as const,
                        period: "PER_ATTEMPT" as const,
                        mode: "LIMITED" as const,
                        limitValue: new Prisma.Decimal(protection.concurrencyLimit),
                      },
                      {
                        metric: "SPEND" as const,
                        period: "UTC_DAY" as const,
                        mode: "LIMITED" as const,
                        limitValue: new Prisma.Decimal(protection.dailySpendLimit),
                        currency: provider.PricingVersions[0]!.currency,
                      },
                    ];
                  const rule = (
                    metric: "CONCURRENCY" | "TOKENS" | "SPEND",
                    period: "PER_ATTEMPT" | "UTC_DAY" | "UTC_MONTH" | "LIFETIME",
                    value:
                      | { mode: "UNLIMITED"; limitValue: null }
                      | { mode: "LIMITED"; limitValue: string | number },
                  ) => ({
                    metric,
                    period,
                    mode: value.mode,
                    limitValue:
                      value.mode === "LIMITED" ? new Prisma.Decimal(value.limitValue) : null,
                    currency: metric === "SPEND" ? provider.PricingVersions[0]!.currency : null,
                  });
                  return [
                    rule("CONCURRENCY", "PER_ATTEMPT", rules.concurrency),
                    rule("TOKENS", "PER_ATTEMPT", rules.tokensPerAttempt),
                    rule("TOKENS", "UTC_DAY", rules.tokensPerDay),
                    rule("TOKENS", "UTC_MONTH", rules.tokensPerMonth),
                    rule("TOKENS", "LIFETIME", rules.tokensLifetime),
                    rule("SPEND", "UTC_DAY", rules.spendPerDay),
                    rule("SPEND", "UTC_MONTH", rules.spendPerMonth),
                  ];
                })(),
              },
            },
            select: { id: true },
          });
          await tx.providerAuditEvent.create({
            data: {
              userId,
              providerAccountId: provider.providerAccountId,
              action: "BUDGET_CREATED",
              subjectId: budget.id,
              metadata: { source: "guarded_pool_wizard" },
            },
          });
        }
        await tx.capacityAuditEvent.create({
          data: {
            userId,
            actorUserId: userId,
            action: "CREATE",
            resourceType: "MODEL_POOL",
            resourceId: pool.id,
          },
        });
        // Attaching external members turns fallback on: audit it. The other
        // fallback fields keep their schema defaults (not a change).
        await recordPoolFallbackAudit(tx, {
          userId,
          poolId: pool.id,
          before: null,
          after: hasPublicOverflow ? { fallbackEnabled: true } : {},
          source: poolFallbackChangeSource(context),
        });
        guardedSetupTestFailure?.();
        const created = await tx.modelPool.findUnique({
          where: { id: pool.id },
          select: poolSelect,
        });
        // Documented, accepted exception: no `data.reason` is attached here.
        // This is an internal invariant violation (the pool row vanished after
        // a successful create inside the same transaction); it is not a user
        // correctable guarded-create failure, so the client's generic rollback
        // copy applies. Do not add a reason code for this branch.
        if (!created) throw new ORPCError("INTERNAL_SERVER_ERROR");
        return serializePool(created);
      });
    }),
};

export const forwarderManagementRouter = {
  ...metricRoutingProcedures,
  ...guardedPoolProcedures,
  ...cliDeviceProcedures,
  ...poolProcedures,
  ...poolMemberProcedures,
};
