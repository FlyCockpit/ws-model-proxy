import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

if (!databaseUrl)
  console.warn("[provider-budget] skipped: SCHEMA_VALIDATION_DATABASE_URL is not configured");

integration("provider budget admission and reconciliation", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  let service: typeof import("./provider-budget.js");

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    service = await import("./provider-budget.js");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture(options?: {
    attachment?: boolean;
    metric?: "CONCURRENCY" | "TOKENS";
    noPolicy?: boolean;
  }) {
    if (!db) throw new Error("database unavailable");
    const suffix = crypto.randomUUID();
    const user = await db.user.create({
      data: { name: "Budget proof", email: `budget-${suffix}@example.test` },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: user.id,
        providerType: "proof",
        label: `budget-${suffix}`,
        baseUrl: "https://example.test",
        endpointIdentity: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: user.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    let poolId: string | undefined;
    if (options?.attachment) {
      const pool = await db.modelPool.create({
        data: { userId: user.id, name: `Pool ${suffix}`, slug: `pool-${suffix}` },
      });
      poolId = pool.id;
    }
    const policies = options?.noPolicy
      ? []
      : await Promise.all([
          db.providerBudgetPolicy.create({
            data: {
              userId: user.id,
              providerAccountId: account.id,
              scopeType: "PROVIDER_ACCOUNT",
              active: true,
              activatedAt: new Date(),
              Rules: {
                create: {
                  metric: options?.metric ?? "CONCURRENCY",
                  period: options?.metric === "TOKENS" ? "UTC_DAY" : "PER_ATTEMPT",
                  mode: "LIMITED",
                  limitValue: options?.metric === "TOKENS" ? 10 : 1,
                },
              },
            },
          }),
          ...(poolId
            ? [
                db.providerBudgetPolicy.create({
                  data: {
                    userId: user.id,
                    providerAccountId: account.id,
                    providerModelId: model.id,
                    poolId,
                    scopeType: "POOL_PROVIDER_MODEL",
                    active: true,
                    activatedAt: new Date(),
                    Rules: {
                      create: {
                        metric: options?.metric ?? "CONCURRENCY",
                        period: options?.metric === "TOKENS" ? "UTC_DAY" : "PER_ATTEMPT",
                        mode: "LIMITED",
                        limitValue: options?.metric === "TOKENS" ? 10 : 1,
                      },
                    },
                  },
                }),
              ]
            : []),
        ]);
    return { user, account, model, poolId, policies };
  }

  function attempt(
    row: Awaited<ReturnType<typeof fixture>>,
    attemptId: string,
    liability: { tokens?: bigint; accountingVersion: string } = { accountingVersion: "usage-v1" },
  ) {
    return {
      userId: row.user.id,
      providerAccountId: row.account.id,
      providerModelId: row.model.id,
      poolId: row.poolId,
      requestId: `request-${attemptId}`,
      attemptId,
      fencingToken: 1n,
      liability,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  it("serializes two distinct attempts across every applicable concurrency scope", async () => {
    if (!db) return;
    const row = await fixture({ attachment: true });
    const [first, second] = await Promise.all([
      service.admitProviderBudget(attempt(row, `a-${crypto.randomUUID()}`)),
      service.admitProviderBudget(attempt(row, `b-${crypto.randomUUID()}`)),
    ]);
    expect([first.admitted, second.admitted].sort()).toEqual([false, true]);
    const winner = first.admitted ? first : second;
    if (!winner.admitted) throw new Error("winner unavailable");
    expect(winner.reservationIds).toHaveLength(2);
  });

  it("returns only an exact complete live replay and rejects fencing or request conflicts", async () => {
    const row = await fixture({ attachment: true, metric: "TOKENS" });
    const original = attempt(row, `replay-${crypto.randomUUID()}`, {
      tokens: 3n,
      accountingVersion: "usage-v1",
    });
    const admitted = await service.admitProviderBudget(original);
    await expect(service.admitProviderBudget(original)).resolves.toEqual(admitted);
    await expect(service.admitProviderBudget({ ...original, fencingToken: 2n })).rejects.toThrow(
      "conflict",
    );
    await expect(
      service.admitProviderBudget({ ...original, requestId: "different" }),
    ).rejects.toThrow("conflict");
    await service.reconcileProviderBudget({
      ...original,
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
    });
    await expect(service.admitProviderBudget(original)).rejects.toThrow("no longer replayable");
  });

  it("replays the immutable admitted graph after its policies change", async () => {
    if (!db) return;
    const row = await fixture({ attachment: true, metric: "TOKENS" });
    const original = attempt(row, `policy-replay-${crypto.randomUUID()}`, {
      tokens: 3n,
      accountingVersion: "usage-v1",
    });
    const admitted = await service.admitProviderBudget(original);
    await db.providerBudgetPolicy.updateMany({
      where: { id: { in: row.policies.map(({ id }) => id) } },
      data: { active: false, deactivatedAt: new Date() },
    });
    await expect(service.admitProviderBudget(original)).resolves.toEqual(admitted);

    const firstReservation = admitted.admitted ? admitted.reservationIds[0] : undefined;
    if (!firstReservation) throw new Error("reservation unavailable");
    await db.providerBudgetReservation.update({
      where: { id: firstReservation },
      data: { state: "SETTLED", settledValue: 3, settledAt: new Date() },
    });
    await expect(service.admitProviderBudget(original)).rejects.toThrow("no longer replayable");
  });

  it("fails closed for partial token usage and appends one terminal ledger row", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `partial-${crypto.randomUUID()}`, {
      tokens: 8n,
      accountingVersion: "usage-v1",
    });
    await service.admitProviderBudget(original);
    const terminal = {
      ...original,
      reason: "FAILED" as const,
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT" as const,
      usage: {
        accountingVersion: "usage-v1",
        inputTokens: 2n,
        confidence: "REPORTED" as const,
      },
    };
    await service.reconcileProviderBudget(terminal);
    await service.reconcileProviderBudget(terminal);
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { attemptId: original.attemptId },
    });
    expect(reservation.settledValue?.toString()).toBe("8");
    const ledgers = await db.providerUsageLedger.findMany({
      where: { attemptId: original.attemptId },
    });
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.usageKnown).toBe(false);
    expect(ledgers[0]?.costKnown).toBe(false);
    expect(ledgers[0]?.terminalReason).toBe("FAILED");
  });

  it("crash sweep retains expired liability and preserves the reservation identity", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `crash-${crypto.randomUUID()}`, {
      tokens: 4n,
      accountingVersion: "usage-v1",
    });
    original.expiresAt = new Date(Date.now() + 100);
    await service.admitProviderBudget(original);
    const repaired = await service.repairExpiredProviderBudgets(new Date(Date.now() + 1_000));
    expect(repaired).toBeGreaterThanOrEqual(1);
    const ledger = await db.providerUsageLedger.findUniqueOrThrow({
      where: {
        attemptId_fencingToken_sourceVersion: {
          attemptId: original.attemptId,
          fencingToken: 1n,
          sourceVersion: "crash-recovery-v1",
        },
      },
    });
    expect(ledger.requestId).toBe(original.requestId);
    expect(ledger.terminalReason).toBe("CRASH_RECOVERY");
  });

  it("anchors and reconciles an attempt even when no finite policy creates a reservation", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    const original = attempt(row, `unlimited-${crypto.randomUUID()}`, {
      tokens: 5n,
      accountingVersion: "usage-v1",
    });
    await expect(service.admitProviderBudget(original)).resolves.toEqual({
      admitted: true,
      reservationIds: [],
    });
    await service.reconcileProviderBudget({
      ...original,
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        accountingVersion: "usage-v1",
        authoritativeBillableTokens: 3n,
        confidence: "REPORTED",
      },
    });
    expect(await db.providerAttempt.count({ where: { attemptId: original.attemptId } })).toBe(1);
    const ledger = await db.providerUsageLedger.findFirstOrThrow({
      where: { attemptId: original.attemptId },
    });
    expect(ledger.reservationId).toBeNull();
    expect(ledger.billableTotal).toBe(3n);
  });

  it("appends one idempotent delayed usage adjustment without rewriting history", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `delayed-${crypto.randomUUID()}`, {
      tokens: 8n,
      accountingVersion: "usage-v1",
    });
    await service.admitProviderBudget(original);
    await service.reconcileProviderBudget({
      ...original,
      reason: "TIMEOUT",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
    });
    const delayed = {
      ...original,
      reason: "COMPLETED" as const,
      sourceVersion: "provider-final-v2",
      revisionSequence: 2n,
      revisionKind: "SNAPSHOT" as const,
      usageSource: "provider-poll",
      usage: {
        accountingVersion: "usage-v1",
        inputTokens: 2n,
        additionalBillableTokens: 1n,
        categoriesComplete: true,
        confidence: "REPORTED" as const,
        rawUsage: { input_tokens: 2, special_tokens: 1 },
      },
    };
    await service.reconcileProviderBudget(delayed);
    await service.reconcileProviderBudget(delayed);

    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { attemptId: original.attemptId },
    });
    expect(reservation.settledValue?.toString()).toBe("8");
    const settlements = await db.providerBudgetSettlement.findMany({
      where: { reservationId: reservation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(settlements.map((entry) => entry.settledValue.toString())).toEqual(["8", "-5"]);
    const ledgers = await db.providerUsageLedger.findMany({
      where: { attemptId: original.attemptId },
      orderBy: { createdAt: "asc" },
    });
    expect(ledgers).toHaveLength(2);
    expect(ledgers[1]).toMatchObject({
      sourceVersion: "provider-final-v2",
      usageSource: "provider-poll",
      categoriesComplete: true,
      additionalBillableTokens: 1n,
      billableTotal: 3n,
      usageKnown: true,
    });
  });

  it("rejects reverse and mutated revisions while allowing ordered corrections both ways", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `ordered-${crypto.randomUUID()}`, {
      tokens: 8n,
      accountingVersion: "usage-v1",
    });
    await service.admitProviderBudget(original);
    const revision = (sequence: bigint, total: bigint, sourceVersion: string) => ({
      ...original,
      reason: "COMPLETED" as const,
      sourceVersion,
      revisionSequence: sequence,
      revisionKind: "SNAPSHOT" as const,
      usage: {
        accountingVersion: "usage-v1",
        authoritativeBillableTokens: total,
        confidence: "REPORTED" as const,
      },
    });
    await service.reconcileProviderBudget(revision(1n, 8n, "provider-1"));
    await service.reconcileProviderBudget(revision(3n, 3n, "provider-3"));
    await expect(service.reconcileProviderBudget(revision(2n, 7n, "provider-2"))).rejects.toThrow(
      "Stale",
    );
    await expect(service.reconcileProviderBudget(revision(3n, 4n, "provider-3"))).rejects.toThrow(
      "conflict",
    );
    await service.reconcileProviderBudget(revision(4n, 6n, "provider-4"));
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { attemptId: original.attemptId },
    });
    const settlements = await db.providerBudgetSettlement.findMany({
      where: { reservationId: reservation.id },
      orderBy: { revisionSequence: "asc" },
    });
    expect(settlements.map((entry) => entry.settledValue.toString())).toEqual(["8", "-5", "3"]);
  });

  it("hashes only normalized persisted revision semantics", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `canonical-${crypto.randomUUID()}`, {
      tokens: 8n,
      accountingVersion: "usage-v1",
    });
    await service.admitProviderBudget(original);
    const revision = {
      ...original,
      reason: "COMPLETED" as const,
      sourceVersion: " provider-v1 ",
      usageSource: " provider-poll ",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT" as const,
      usage: {
        accountingVersion: " usage-v1 ",
        authoritativeBillableTokens: 3n,
        reportedCost: "1.00",
        reportedCostCurrency: " usd ",
        reportedCostPricingVersion: " price-v1 ",
        reportedCostSource: " header ",
        confidence: "REPORTED" as const,
      },
      transportTrace: "first delivery",
    };
    await service.reconcileProviderBudget(revision);
    const persisted = await db.providerUsageLedger.findFirstOrThrow({
      where: { attemptId: original.attemptId, sourceVersion: "provider-v1" },
    });
    expect(persisted).toMatchObject({
      usageSource: "provider-poll",
      reportedCostSource: "header",
    });
    const equivalentRetry = {
      ...revision,
      sourceVersion: "provider-v1",
      usageSource: "provider-poll",
      transportTrace: "retry delivery",
      usage: {
        ...revision.usage,
        accountingVersion: "usage-v1",
        reportedCost: new (await import("@ws-model-proxy/db")).Prisma.Decimal("1"),
        reportedCostCurrency: "USD",
        reportedCostPricingVersion: "price-v1",
        reportedCostSource: "header",
      },
    };
    await expect(service.reconcileProviderBudget(equivalentRetry)).resolves.toBeUndefined();
    await expect(
      service.reconcileProviderBudget({
        ...revision,
        sourceVersion: "provider-v1",
        usage: { ...revision.usage, authoritativeBillableTokens: 4n },
      }),
    ).rejects.toThrow("conflict");
  });

  it("persists source accounting identity and rejects a changed identity for the same revision", async () => {
    if (!db) return;
    const row = await fixture({ metric: "TOKENS" });
    const original = attempt(row, `mismatched-accounting-${crypto.randomUUID()}`, {
      tokens: 8n,
      accountingVersion: "usage-v1",
    });
    await service.admitProviderBudget(original);
    const revision = {
      ...original,
      reason: "COMPLETED" as const,
      sourceVersion: "provider-v1",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT" as const,
      usage: {
        accountingVersion: "provider-usage-v2",
        authoritativeBillableTokens: 3n,
        confidence: "REPORTED" as const,
      },
    };
    await service.reconcileProviderBudget(revision);
    const persisted = await db.providerUsageLedger.findFirstOrThrow({
      where: { attemptId: original.attemptId, sourceVersion: "provider-v1" },
    });
    expect(persisted).toMatchObject({
      accountingVersion: "usage-v1",
      sourceUsageAccountingVersion: "provider-usage-v2",
      usageKnown: false,
    });
    const settlement = await db.providerBudgetSettlement.findFirstOrThrow({
      where: { attemptId: original.attemptId, sourceVersion: "provider-v1" },
    });
    expect(settlement).toMatchObject({
      accountingVersion: "usage-v1",
      sourceUsageAccountingVersion: "provider-usage-v2",
    });
    await expect(
      service.reconcileProviderBudget({
        ...revision,
        usage: { ...revision.usage, accountingVersion: "provider-usage-v3" },
      }),
    ).rejects.toThrow("conflict");
    await expect(
      service.reconcileProviderBudget({
        ...revision,
        usage: { ...revision.usage, authoritativeBillableTokens: 4n },
      }),
    ).rejects.toThrow("conflict");
  });

  it("crash-repairs an expired no-policy attempt anchor exactly once", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    const original = attempt(row, `no-policy-crash-${crypto.randomUUID()}`);
    original.expiresAt = new Date(Date.now() + 100);
    await service.admitProviderBudget(original);
    await service.repairExpiredProviderBudgets(new Date(Date.now() + 1_000));
    await service.repairExpiredProviderBudgets(new Date(Date.now() + 2_000));
    const ledgers = await db.providerUsageLedger.findMany({
      where: { attemptId: original.attemptId },
    });
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]).toMatchObject({
      terminalReason: "CRASH_RECOVERY",
      revisionSequence: 0n,
      revisionKind: "SNAPSHOT",
      reservationId: null,
    });
  });

  it("retains independent raw cost provenance while settling only anchor-matched pricing", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    await db.providerPricingVersion.create({
      data: {
        userId: row.user.id,
        providerAccountId: row.account.id,
        providerModelId: row.model.id,
        version: "price-v1",
        currency: "USD",
        pricing: { input: "1" },
        effectiveAt: new Date(Date.now() - 1_000),
      },
    });
    const original = {
      ...attempt(row, `cost-evidence-${crypto.randomUUID()}`),
      liability: {
        spend: "9",
        currency: "USD",
        pricingVersion: "price-v1",
        accountingVersion: "usage-v1",
      },
    };
    await service.admitProviderBudget(original);
    await service.reconcileProviderBudget({
      ...original,
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        accountingVersion: "usage-v1",
        confidence: "REPORTED",
        reportedCost: "7",
        reportedCostCurrency: "EUR",
        reportedCostPricingVersion: "provider-price-v9",
        reportedCostSource: "provider-header",
        calculatedCost: "5",
        calculatedCostCurrency: "USD",
        calculatedCostPricingVersion: "price-v1",
        calculatedCostSource: "local-price-table",
      },
    });
    const ledger = await db.providerUsageLedger.findFirstOrThrow({
      where: { attemptId: original.attemptId },
    });
    expect(ledger).toMatchObject({
      reportedCostCurrency: "EUR",
      reportedCostPricingVersion: "provider-price-v9",
      reportedCostSource: "provider-header",
      calculatedCostCurrency: "USD",
      calculatedCostPricingVersion: "price-v1",
      calculatedCostSource: "local-price-table",
      costKnown: true,
      currency: "USD",
      pricingVersion: "price-v1",
    });
    expect(ledger.reportedCost?.toString()).toBe("7");
    expect(ledger.calculatedCost?.toString()).toBe("5");
    expect(ledger.settledCost?.toString()).toBe("5");
  });
});
