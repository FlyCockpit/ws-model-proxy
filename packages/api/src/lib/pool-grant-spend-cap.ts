import { ORPCError } from "@orpc/server";
import { Prisma } from "@ws-model-proxy/db";
import { z } from "zod";

/** Owner-paid `:external` spend cap for one exact pool grant. */
export const poolGrantSpendCapSchema = z
  .object({
    limit: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    period: z.enum(["UTC_DAY", "UTC_MONTH"]),
  })
  .refine((value) => value.limit !== "0", { message: "Spend cap must be positive" });

export type PoolGrantSpendCap = z.infer<typeof poolGrantSpendCapSchema>;

type SpendRule = {
  limitValue: { toString(): string } | string | number | null;
  currency: string | null;
  period: string;
};

/** Active POOL_GRANT spend rule, or null when the grant has no cap. */
export function serializePoolGrantSpendCap(
  policies: readonly { Rules: readonly SpendRule[] }[] | undefined,
): PoolGrantSpendCap | null {
  const rule = policies?.[0]?.Rules[0];
  if (!rule?.limitValue || !rule.currency) return null;
  if (rule.period !== "UTC_DAY" && rule.period !== "UTC_MONTH") return null;
  return {
    limit: String(rule.limitValue),
    currency: rule.currency,
    period: rule.period,
  };
}

function sameSpendCap(policy: { Rules: readonly SpendRule[] }, spend: PoolGrantSpendCap): boolean {
  const rule = policy.Rules[0];
  return (
    policy.Rules.length === 1 &&
    rule !== undefined &&
    rule.period === spend.period &&
    rule.currency === spend.currency &&
    String(rule.limitValue ?? "") === spend.limit
  );
}

/**
 * Activate, replace, or clear the POOL_GRANT spend cap. Caller must already
 * hold the owner fence and `fences.budgetGrant(userId, poolGrantId)`.
 */
export async function upsertPoolGrantSpendCap(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    poolId: string;
    poolGrantId: string;
    spend: PoolGrantSpendCap | null;
  },
): Promise<void> {
  const latest = await tx.providerBudgetPolicy.findFirst({
    where: {
      userId: input.userId,
      scopeType: "POOL_GRANT",
      poolGrantId: input.poolGrantId,
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
