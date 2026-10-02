import { ORPCError } from "@orpc/server";
import { Prisma } from "@ws-model-proxy/db";
import { type PoolGrantSpendCap, poolGrantSpendCapSchema } from "./pool-grant-spend-cap-schema";

export { type PoolGrantSpendCap, poolGrantSpendCapSchema };

type SpendRule = {
  limitValue: { toString(): string } | string | number | null;
  currency: string | null;
  period: string;
};

function serializeLimit(value: SpendRule["limitValue"]): string {
  return new Prisma.Decimal(String(value)).toFixed();
}

/** Active POOL_GRANT spend rule, or null when the grant has no cap. */
export function serializePoolGrantSpendCap(
  policies: readonly { Rules: readonly SpendRule[] }[] | undefined,
): PoolGrantSpendCap | null {
  const rule = policies?.[0]?.Rules[0];
  if (!rule?.limitValue || !rule.currency) return null;
  if (rule.period !== "UTC_DAY" && rule.period !== "UTC_MONTH") return null;
  return {
    limit: serializeLimit(rule.limitValue),
    currency: rule.currency,
    period: rule.period,
  };
}

function sameSpendCap(policy: { Rules: readonly SpendRule[] }, spend: PoolGrantSpendCap): boolean {
  const rule = policy.Rules[0];
  if (policy.Rules.length !== 1 || rule === undefined) return false;
  if (rule.period !== spend.period || rule.currency !== spend.currency || !rule.limitValue)
    return false;
  try {
    return new Prisma.Decimal(String(rule.limitValue)).equals(new Prisma.Decimal(spend.limit));
  } catch {
    return false;
  }
}

export function grantSpendFenceKey(poolId: string, granteeUserId: string): string {
  return `${poolId}:${granteeUserId}`;
}

/**
 * Unique overflow pricing currency on the pool, if every attached public
 * member agrees. Mixed or missing pricing leaves the caller's currency.
 */
export async function resolvePoolSpendCurrency(
  tx: Prisma.TransactionClient,
  input: { userId: string; poolId: string },
): Promise<string | null> {
  const members = await tx.poolMember.findMany({
    where: {
      poolId: input.poolId,
      ModelPool: { userId: input.userId },
      tier: "PUBLIC_OVERFLOW",
    },
    select: {
      ExecutionTarget: {
        select: {
          ProviderModel: {
            select: {
              PricingVersions: {
                where: { status: { in: ["ACTIVE", "RETIRED"] } },
                orderBy: { effectiveAt: "desc" },
                take: 1,
                select: { currency: true },
              },
            },
          },
        },
      },
    },
  });
  const currencies = new Set(
    members
      .map((member) => member.ExecutionTarget?.ProviderModel?.PricingVersions[0]?.currency)
      .filter((currency): currency is string => Boolean(currency)),
  );
  return currencies.size === 1 ? [...currencies][0]! : null;
}

/**
 * Activate, replace, or clear the POOL_GRANT spend cap. Caller must already
 * hold the owner fence and `fences.budgetGrant(userId, poolId, granteeUserId)`.
 */
export async function upsertPoolGrantSpendCap(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    poolId: string;
    poolGrantId: string;
    granteeUserId: string;
    spend: PoolGrantSpendCap | null;
  },
): Promise<void> {
  if (input.spend) {
    const poolCurrency = await resolvePoolSpendCurrency(tx, input);
    if (poolCurrency && input.spend.currency !== poolCurrency)
      throw new ORPCError("BAD_REQUEST", {
        message: `Spend cap currency must be ${poolCurrency}.`,
      });
  }
  const latest = await tx.providerBudgetPolicy.findFirst({
    where: {
      userId: input.userId,
      scopeType: "POOL_GRANT",
      poolId: input.poolId,
      granteeUserId: input.granteeUserId,
    },
    orderBy: { version: "desc" },
    include: { Rules: true },
  });
  const current = latest?.active ? latest : null;
  if (input.spend === null) {
    if (!current) return;
    await tx.providerBudgetPolicy.update({
      where: { id: current.id },
      data: { active: false, deactivatedAt: new Date() },
    });
    await tx.providerAuditEvent.create({
      data: {
        userId: input.userId,
        action: "BUDGET_DEACTIVATED",
        subjectId: current.id,
      },
    });
    return;
  }
  if (current && sameSpendCap(current, input.spend)) return;
  if (current) {
    await tx.providerBudgetPolicy.update({
      where: { id: current.id },
      data: { active: false, deactivatedAt: new Date() },
    });
  }
  const row = await tx.providerBudgetPolicy.create({
    data: {
      userId: input.userId,
      scopeType: "POOL_GRANT",
      providerAccountId: null,
      poolId: input.poolId,
      providerModelId: null,
      poolGrantId: input.poolGrantId,
      granteeUserId: input.granteeUserId,
      version: (latest?.version ?? 0) + 1,
      active: true,
      activatedAt: new Date(),
      Rules: {
        create: {
          metric: "SPEND",
          period: input.spend.period,
          mode: "LIMITED",
          limitValue: new Prisma.Decimal(input.spend.limit),
          currency: input.spend.currency,
        },
      },
    },
  });
  await tx.providerAuditEvent.create({
    data: {
      userId: input.userId,
      action: current ? "BUDGET_UPDATED" : "BUDGET_CREATED",
      subjectId: row.id,
      metadata: current ? { replacesPolicyId: current.id } : {},
    },
  });
}

export function assertPoolGrantSpendRules(
  rules: readonly {
    metric: string;
    period: string;
    mode: string;
    limitValue: string | null;
    currency: string | null;
  }[],
): void {
  if (
    rules.length === 0 ||
    rules.some(
      (rule) =>
        rule.metric !== "SPEND" ||
        rule.mode !== "LIMITED" ||
        rule.limitValue === null ||
        rule.currency === null ||
        (rule.period !== "UTC_DAY" && rule.period !== "UTC_MONTH"),
    )
  )
    throw new ORPCError("BAD_REQUEST", {
      message: "A grant spend cap is SPEND only (UTC_DAY or UTC_MONTH).",
    });
}
