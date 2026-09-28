import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { GuardedPoolCreateFailureReason } from "./guarded-pool-create-reasons";
import { isMcpSession } from "./mcp-session";

/**
 * Owner external-fallback settings of a model pool (fallback redesign D-K,
 * issue #67): `fallbackEnabled`, `fallbackForGrantees` and
 * `externalAfterWaitMs`. Shared by the dashboard pool procedures and the
 * dedicated pool-fallback procedures that back the MCP tools, so every write
 * path runs the same checks and writes the same audit trail.
 */
export type PoolFallbackSettings = {
  fallbackEnabled: boolean;
  fallbackForGrantees: boolean;
  externalAfterWaitMs: number;
};

export const poolFallbackSettingsSelect = {
  fallbackEnabled: true,
  fallbackForGrantees: true,
  externalAfterWaitMs: true,
} as const satisfies Prisma.ModelPoolSelect;

export function assertProviderEgressReleaseGate(reason?: GuardedPoolCreateFailureReason): void {
  if (!env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED)
    throw new ORPCError("NOT_FOUND", {
      message: "Provider egress is not enabled for this deployment.",
      ...(reason !== undefined ? { data: { reason } } : {}),
    });
}

/**
 * A save that sets a NEW external-fallback wait must not exceed the pool's
 * resulting local wait budget (the value after this save). A save that does
 * not change the external wait is never rejected because of it: the stored
 * value may exceed a budget lowered later, and the runtime always waits
 * min(budget, externalAfterWaitMs), so an out-of-order pair is harmless.
 */
export function assertExternalAfterWaitWithinBudget({
  externalAfterWaitMs,
  currentExternalAfterWaitMs,
  capacityWaitBudgetMs,
}: {
  externalAfterWaitMs: number | undefined;
  /** Stored value, or null when creating a pool. */
  currentExternalAfterWaitMs: number | null;
  /** The pool's local wait budget after this save (null = unbounded). */
  capacityWaitBudgetMs: number | null;
}): void {
  if (externalAfterWaitMs === undefined || externalAfterWaitMs === currentExternalAfterWaitMs)
    return;
  if (capacityWaitBudgetMs !== null && externalAfterWaitMs > capacityWaitBudgetMs)
    throw new ORPCError("BAD_REQUEST", {
      message: "The external fallback wait cannot exceed the pool's local wait budget.",
    });
}

/**
 * Turning fallback ON needs the deployment switch (checked by the caller)
 * and an audited, active LIMITED or UNLIMITED concurrency protection policy
 * on every external member. Turning it OFF is always allowed.
 */
export async function assertPoolFallbackEnableable(poolId: string, userId: string): Promise<void> {
  const attachments = await prisma.poolMember.findMany({
    where: { poolId, tier: "PUBLIC_OVERFLOW" },
    select: {
      id: true,
      ExecutionTarget: {
        select: {
          ProviderModel: { select: { id: true, providerAccountId: true } },
        },
      },
    },
  });
  const targets = attachments.flatMap((attachment) => {
    const model = attachment.ExecutionTarget?.ProviderModel;
    return model ? [{ attachmentId: attachment.id, ...model }] : [];
  });
  if (targets.length !== attachments.length) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Every public overflow attachment must reference a provider model.",
    });
  }
  const policies = await prisma.providerBudgetPolicy.findMany({
    where: {
      userId,
      active: true,
      scopeType: "POOL_PROVIDER_MODEL",
      poolId,
      OR: targets.map(({ id, providerAccountId }) => ({
        providerModelId: id,
        providerAccountId,
      })),
    },
    select: {
      id: true,
      providerModelId: true,
      providerAccountId: true,
      activatedAt: true,
      Rules: {
        where: { metric: "CONCURRENCY", period: "PER_ATTEMPT" },
        select: { mode: true, limitValue: true },
      },
    },
  });
  const validPolicies = new Map(
    policies
      .filter(
        (policy) =>
          policy.activatedAt &&
          policy.Rules.length === 1 &&
          policy.Rules.every(
            (rule) =>
              (rule.mode === "LIMITED" &&
                rule.limitValue !== null &&
                Number(rule.limitValue.toString()) > 0) ||
              (rule.mode === "UNLIMITED" && rule.limitValue === null),
          ),
      )
      .map((policy) => [`${policy.providerAccountId}:${policy.providerModelId}`, policy]),
  );
  const selectedPolicies = targets.map((target) =>
    validPolicies.get(`${target.providerAccountId}:${target.id}`),
  );
  if (selectedPolicies.some((policy) => !policy)) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "Every public overflow attachment requires an active explicit LIMITED or UNLIMITED concurrency policy.",
    });
  }
  const auditChecks = await Promise.all(
    selectedPolicies.map((policy) =>
      prisma.providerAuditEvent.findFirst({
        where: {
          userId,
          providerAccountId: policy!.providerAccountId,
          subjectId: policy!.id,
          action: { in: ["BUDGET_CREATED", "BUDGET_UPDATED", "BUDGET_ACTIVATED"] },
        },
        select: { id: true },
      }),
    ),
  );
  if (auditChecks.some((audit) => !audit)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Every public overflow protection policy must have an activation audit trail.",
    });
  }
}

/** Where a fallback change came from. MCP sessions carry an `mcp:` session id. */
export type PoolFallbackChangeSource = "mcp" | "dashboard";

export function poolFallbackChangeSource(context: {
  session: { session: { id: string } };
}): PoolFallbackChangeSource {
  return isMcpSession(context) ? "mcp" : "dashboard";
}

/**
 * Audit one change of a pool's external-fallback settings: a
 * `POOL_FALLBACK_UPDATED` provider audit event (subject = pool id) with the
 * before/after values of the fields that changed and the change source.
 * Writes nothing when no fallback field changed. Call it inside the write
 * transaction, after the pool row lock, so the event commits with the change.
 *
 * For a pool created in this transaction pass `before: null` and, in
 * `after`, only the fields the creator set explicitly (their stored values):
 * each is recorded as `{ before: null, after }`. Fields left to the schema
 * defaults (packages/db/prisma/schema/forwarder.prisma, the single source of
 * those defaults) are not a change and are not recorded.
 */
export async function recordPoolFallbackAudit(
  tx: Prisma.TransactionClient,
  {
    userId,
    poolId,
    before,
    after,
    source,
  }: {
    userId: string;
    poolId: string;
    before: PoolFallbackSettings | null;
    after: PoolFallbackSettings | Partial<PoolFallbackSettings>;
    source: PoolFallbackChangeSource;
  },
): Promise<boolean> {
  const changes: Record<string, { before: boolean | number | null; after: boolean | number }> = {};
  for (const field of ["fallbackEnabled", "fallbackForGrantees", "externalAfterWaitMs"] as const) {
    const next = after[field];
    if (next === undefined) continue;
    const previous = before?.[field] ?? null;
    if (previous !== next) changes[field] = { before: previous, after: next };
  }
  if (Object.keys(changes).length === 0) return false;
  await tx.providerAuditEvent.create({
    data: {
      userId,
      action: "POOL_FALLBACK_UPDATED",
      subjectId: poolId,
      metadata: { source, changes },
    },
  });
  return true;
}
