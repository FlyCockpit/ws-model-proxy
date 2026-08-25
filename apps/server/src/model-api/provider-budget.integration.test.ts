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
                      create: [
                        {
                          metric: options?.metric ?? "CONCURRENCY",
                          period: options?.metric === "TOKENS" ? "UTC_DAY" : "PER_ATTEMPT",
                          mode: "LIMITED",
                          limitValue: options?.metric === "TOKENS" ? 10 : 1,
                        },
                        ...(options?.metric === "TOKENS"
                          ? [
                              {
                                metric: "CONCURRENCY" as const,
                                period: "PER_ATTEMPT" as const,
                                mode: "LIMITED" as const,
                                limitValue: 1,
                              },
                            ]
                          : []),
                      ],
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

  type Rule = {
    metric: "CONCURRENCY" | "TOKENS" | "SPEND";
    period: "PER_ATTEMPT" | "UTC_DAY" | "UTC_MONTH" | "LIFETIME";
    mode?: "LIMITED" | "UNLIMITED";
    limitValue?: number | string;
    currency?: string;
  };

  async function policy(
    row: Awaited<ReturnType<typeof fixture>>,
    rules: Rule[],
    options?: { poolId?: string; version?: number; active?: boolean; activatedAt?: Date },
  ) {
    if (!db) throw new Error("database unavailable");
    const poolId = options?.poolId;
    return db.providerBudgetPolicy.create({
      data: {
        userId: row.user.id,
        providerAccountId: row.account.id,
        providerModelId: poolId ? row.model.id : undefined,
        poolId,
        scopeType: poolId ? "POOL_PROVIDER_MODEL" : "PROVIDER_ACCOUNT",
        version: options?.version ?? 1,
        active: options?.active ?? true,
        activatedAt: options?.activatedAt ?? new Date(Date.now() - 86_400_000),
        Rules: {
          create: rules.map((rule) => ({
            metric: rule.metric,
            period: rule.period,
            mode: rule.mode ?? "LIMITED",
            limitValue: rule.mode === "UNLIMITED" ? undefined : rule.limitValue,
            currency: rule.currency,
          })),
        },
      },
      include: { Rules: true },
    });
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

  it("fails closed when a public pool attachment has no explicit concurrency protection", async () => {
    if (!db) return;
    const row = await fixture({ attachment: true, noPolicy: true });
    await policy(row, [{ metric: "TOKENS", period: "UTC_DAY", limitValue: 100 }], {
      poolId: row.poolId,
    });
    await expect(
      service.admitProviderBudget(attempt(row, `unprotected-${crypto.randomUUID()}`)),
    ).resolves.toEqual({ admitted: false, reason: "PROTECTION_POLICY_MISSING" });
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
    await expect(service.admitProviderBudget(original)).resolves.toMatchObject({
      admitted: true,
      providerAttemptId: expect.any(String),
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

  it.each(["UTC_DAY", "UTC_MONTH"] as const)(
    "uses exact %s UTC windows and serializes simultaneous boundary admission",
    async (period) => {
      if (!db) return;
      const row = await fixture({ noPolicy: true });
      const created = await policy(row, [{ metric: "TOKENS", period, limitValue: 10 }]);
      const clock = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock[0]?.now;
      if (!now) throw new Error("database clock unavailable");
      const expected = service.budgetWindow(period, new Date(0), now);
      const previousStart =
        period === "UTC_DAY"
          ? new Date(expected.windowStart!.getTime() - 86_400_000)
          : new Date(
              Date.UTC(
                expected.windowStart!.getUTCFullYear(),
                expected.windowStart!.getUTCMonth() - 1,
                1,
              ),
            );
      const historicRequestId = `historic-request-${crypto.randomUUID()}`;
      const historicAttemptId = `historic-attempt-${crypto.randomUUID()}`;
      const historicExpiry = new Date(Date.now() + 60_000);
      await db.providerAttempt.create({
        data: {
          userId: row.user.id,
          providerAccountId: row.account.id,
          providerModelId: row.model.id,
          requestId: historicRequestId,
          attemptId: historicAttemptId,
          fencingToken: 1n,
          expiresAt: historicExpiry,
          liabilityTokens: 10n,
          accountingVersion: "usage-v1",
        },
      });
      await db.providerBudgetReservation.create({
        data: {
          userId: row.user.id,
          providerAccountId: row.account.id,
          providerModelId: row.model.id,
          policyId: created.id,
          ruleId: created.Rules[0]!.id,
          requestId: historicRequestId,
          attemptId: historicAttemptId,
          fencingToken: 1n,
          metric: "TOKENS",
          period,
          policyVersion: created.version,
          windowStart: previousStart,
          windowEnd: expected.windowStart,
          reservedValue: 10,
          liabilityTokens: 10n,
          accountingVersion: "usage-v1",
          expiresAt: historicExpiry,
        },
      });
      const afterBoundary = await service.admitProviderBudget(
        attempt(row, `${period}-after-${crypto.randomUUID()}`, {
          tokens: 6n,
          accountingVersion: "usage-v1",
        }),
      );
      expect(afterBoundary.admitted).toBe(true);
      const reservation = await db.providerBudgetReservation.findFirstOrThrow({
        where: { userId: row.user.id, attemptId: { startsWith: `${period}-after-` } },
      });
      const admissionExpected = service.budgetWindow(period, new Date(0), reservation.createdAt);
      expect(reservation.utcBasis).toBe("UTC");
      expect(reservation.windowStart).toEqual(admissionExpected.windowStart);
      expect(reservation.windowEnd).toEqual(admissionExpected.windowEnd);

      const raceRow = await fixture({ noPolicy: true });
      await policy(raceRow, [{ metric: "TOKENS", period, limitValue: 10 }]);
      const outcomes = await Promise.all(
        ["left", "right"].map((side) =>
          service.admitProviderBudget(
            attempt(raceRow, `${period}-${side}-${crypto.randomUUID()}`, {
              tokens: 6n,
              accountingVersion: "usage-v1",
            }),
          ),
        ),
      );
      expect(outcomes.map((result) => result.admitted).sort()).toEqual([false, true]);
    },
  );

  it("enforces every simultaneous token period and isolates retry/fallback attempts", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    const created = await policy(
      row,
      (["PER_ATTEMPT", "UTC_DAY", "UTC_MONTH", "LIFETIME"] as const).map((period) => ({
        metric: "TOKENS" as const,
        period,
        limitValue: 10,
      })),
    );
    const first = attempt(row, `retry-${crypto.randomUUID()}`, {
      tokens: 4n,
      accountingVersion: "usage-v1",
    });
    const second = { ...attempt(row, `fallback-${crypto.randomUUID()}`, first.liability) };
    const admittedFirst = await service.admitProviderBudget(first);
    const admittedSecond = await service.admitProviderBudget(second);
    expect(admittedFirst.admitted && admittedFirst.reservationIds).toHaveLength(4);
    expect(admittedSecond.admitted && admittedSecond.reservationIds).toHaveLength(4);
    const reservations = await db.providerBudgetReservation.findMany({
      where: { policyId: created.id },
    });
    expect(new Set(reservations.map((item) => item.attemptId))).toEqual(
      new Set([first.attemptId, second.attemptId]),
    );
    expect(
      reservations.filter((item) => item.period === "PER_ATTEMPT").map((item) => item.attemptId),
    ).toHaveLength(2);

    for (const period of ["PER_ATTEMPT", "UTC_DAY", "UTC_MONTH", "LIFETIME"] as const) {
      const failing = await fixture({ noPolicy: true });
      await policy(failing, [{ metric: "TOKENS", period, limitValue: 3 }]);
      await expect(
        service.admitProviderBudget(
          attempt(failing, `${period}-fail-${crypto.randomUUID()}`, {
            tokens: 4n,
            accountingVersion: "usage-v1",
          }),
        ),
      ).resolves.toMatchObject({ admitted: false, reason: "BUDGET_EXCEEDED" });
    }
  });

  it("fails finite spend closed for missing pricing/currency and reconciles matched liability", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    await policy(row, [
      { metric: "SPEND", period: "UTC_DAY", limitValue: "10", currency: "USD" },
      { metric: "SPEND", period: "UTC_MONTH", limitValue: "20", currency: "USD" },
    ]);
    await expect(
      service.admitProviderBudget(attempt(row, `spend-missing-${crypto.randomUUID()}`)),
    ).resolves.toMatchObject({ admitted: false, reason: "PRICING_UNAVAILABLE" });
    await expect(
      service.admitProviderBudget({
        ...attempt(row, `spend-currency-${crypto.randomUUID()}`),
        liability: {
          spend: "4",
          currency: "EUR",
          pricingVersion: "price-v1",
          accountingVersion: "usage-v1",
        },
      }),
    ).resolves.toMatchObject({ admitted: false, reason: "CURRENCY_UNAVAILABLE" });
    await expect(
      service.admitProviderBudget({
        ...attempt(row, `spend-price-${crypto.randomUUID()}`),
        liability: {
          spend: "4",
          currency: "USD",
          pricingVersion: "missing",
          accountingVersion: "usage-v1",
        },
      }),
    ).resolves.toMatchObject({ admitted: false, reason: "PRICING_UNAVAILABLE" });

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
    const valid = {
      ...attempt(row, `spend-valid-${crypto.randomUUID()}`),
      liability: {
        spend: "4",
        currency: "USD",
        pricingVersion: "price-v1",
        accountingVersion: "usage-v1",
      },
    };
    await expect(service.admitProviderBudget(valid)).resolves.toMatchObject({ admitted: true });
    await service.reconcileProviderBudget({
      ...valid,
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        accountingVersion: "usage-v1",
        confidence: "REPORTED",
        reportedCost: "2.5",
        reportedCostCurrency: "USD",
        reportedCostPricingVersion: "price-v1",
      },
    });
    const reservations = await db.providerBudgetReservation.findMany({
      where: { attemptId: valid.attemptId },
    });
    expect(reservations.map((item) => item.settledValue?.toString())).toEqual(["2.5", "2.5"]);
  });

  it.each(["UTC_DAY", "UTC_MONTH"] as const)(
    "enforces finite %s spend limits without race overspend",
    async (period) => {
      if (!db) return;
      const setup = async (limitValue: number) => {
        const row = await fixture({ noPolicy: true });
        await policy(row, [{ metric: "SPEND", period, limitValue, currency: "USD" }]);
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
        return row;
      };
      const spendAttempt = (row: Awaited<ReturnType<typeof setup>>, id: string, spend: string) => ({
        ...attempt(row, id),
        liability: {
          spend,
          currency: "USD",
          pricingVersion: "price-v1",
          accountingVersion: "usage-v1",
        },
      });

      const rejecting = await setup(5);
      await expect(
        service.admitProviderBudget(
          spendAttempt(rejecting, `spend-${period}-reject-${crypto.randomUUID()}`, "6"),
        ),
      ).resolves.toMatchObject({ admitted: false, reason: "BUDGET_EXCEEDED" });

      const racing = await setup(10);
      const outcomes = await Promise.all(
        ["left", "right"].map((side) =>
          service.admitProviderBudget(
            spendAttempt(racing, `spend-${period}-${side}-${crypto.randomUUID()}`, "6"),
          ),
        ),
      );
      expect(outcomes.map((result) => result.admitted).sort()).toEqual([false, true]);
      expect(
        await db.providerBudgetReservation.count({
          where: { userId: racing.user.id, metric: "SPEND", period },
        }),
      ).toBe(1);
    },
  );

  it("accepts explicit unlimited rules while every accompanying finite rule still binds", async () => {
    if (!db) return;
    const allUnlimited = await fixture({ noPolicy: true });
    await policy(allUnlimited, [
      { metric: "TOKENS", period: "UTC_DAY", mode: "UNLIMITED" },
      { metric: "SPEND", period: "UTC_MONTH", mode: "UNLIMITED", currency: "USD" },
      { metric: "CONCURRENCY", period: "PER_ATTEMPT", mode: "UNLIMITED" },
    ]);
    await expect(
      service.admitProviderBudget(attempt(allUnlimited, `all-unlimited-${crypto.randomUUID()}`)),
    ).resolves.toMatchObject({
      admitted: true,
      providerAttemptId: expect.any(String),
      reservationIds: [],
    });

    const mixed = await fixture({ noPolicy: true });
    await policy(mixed, [
      { metric: "TOKENS", period: "PER_ATTEMPT", mode: "UNLIMITED" },
      { metric: "TOKENS", period: "UTC_DAY", limitValue: 1 },
    ]);
    await expect(
      service.admitProviderBudget(
        attempt(mixed, `mixed-${crypto.randomUUID()}`, {
          tokens: 2n,
          accountingVersion: "usage-v1",
        }),
      ),
    ).resolves.toMatchObject({ admitted: false, reason: "BUDGET_EXCEEDED" });
  });

  it("takes one atomic policy snapshot while activation/replacement races admission", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true });
    const original = await policy(row, [{ metric: "TOKENS", period: "UTC_DAY", limitValue: 1 }]);
    let replacementReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      replacementReady = resolve;
    });
    let allowCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const replacing = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-budget-account:${row.user.id}:${row.account.id}`}, 0))`;
      await tx.providerBudgetPolicy.update({
        where: { id: original.id },
        data: { active: false, deactivatedAt: new Date() },
      });
      const replacement = await tx.providerBudgetPolicy.create({
        data: {
          userId: row.user.id,
          providerAccountId: row.account.id,
          scopeType: "PROVIDER_ACCOUNT",
          version: 2,
          active: true,
          activatedAt: new Date(),
          Rules: {
            create: {
              metric: "TOKENS",
              period: "UTC_DAY",
              mode: "LIMITED",
              limitValue: 10,
            },
          },
        },
      });
      replacementReady();
      await commit;
      return replacement;
    });
    await ready;
    const admission = service.admitProviderBudget(
      attempt(row, `replacement-race-${crypto.randomUUID()}`, {
        tokens: 5n,
        accountingVersion: "usage-v1",
      }),
    );
    allowCommit();
    const [replacement, admitted] = await Promise.all([replacing, admission]);
    expect(admitted.admitted).toBe(true);
    const reservation = await db.providerBudgetReservation.findFirstOrThrow({
      where: { userId: row.user.id, attemptId: { startsWith: "replacement-race-" } },
    });
    expect(reservation).toMatchObject({ policyId: replacement.id, policyVersion: 2 });
  });

  it("keeps attachment pools independent without an aggregate and locks both scopes with one", async () => {
    if (!db) return;
    const row = await fixture({ noPolicy: true, attachment: true });
    const secondPool = await db.modelPool.create({
      data: {
        userId: row.user.id,
        name: `Second ${crypto.randomUUID()}`,
        slug: `second-${crypto.randomUUID()}`,
      },
    });
    await policy(row, [{ metric: "TOKENS", period: "UTC_DAY", limitValue: 8 }], {
      poolId: row.poolId,
    });
    await policy(row, [{ metric: "TOKENS", period: "UTC_DAY", limitValue: 8 }], {
      poolId: secondPool.id,
    });
    const forPool = (poolId: string, id: string) => ({
      ...attempt(row, id, { tokens: 4n, accountingVersion: "usage-v1" }),
      poolId,
    });
    await expect(
      service.admitProviderBudget(forPool(row.poolId!, `pool-a-${crypto.randomUUID()}`)),
    ).resolves.toMatchObject({ admitted: true });
    await expect(
      service.admitProviderBudget(forPool(secondPool.id, `pool-b-${crypto.randomUUID()}`)),
    ).resolves.toMatchObject({ admitted: true });

    await policy(row, [{ metric: "TOKENS", period: "UTC_DAY", limitValue: 5 }]);
    const results = await Promise.all([
      service.admitProviderBudget(forPool(row.poolId!, `aggregate-a-${crypto.randomUUID()}`)),
      service.admitProviderBudget(forPool(secondPool.id, `aggregate-b-${crypto.randomUUID()}`)),
    ]);
    expect(results.map((result) => result.admitted).sort()).toEqual([false, true]);
    const winner = results.find((result) => result.admitted);
    expect(winner?.admitted && winner.reservationIds).toHaveLength(2);
  });

  it.each(["FAILED", "CANCELLED"] as const)(
    "retains provider-billable usage for a %s attempt",
    async (reason) => {
      if (!db) return;
      const row = await fixture({ metric: "TOKENS" });
      const original = attempt(row, `${reason}-${crypto.randomUUID()}`, {
        tokens: 7n,
        accountingVersion: "usage-v1",
      });
      await service.admitProviderBudget(original);
      await service.reconcileProviderBudget({
        ...original,
        reason,
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
        usage: {
          accountingVersion: "usage-v1",
          authoritativeBillableTokens: 3n,
          confidence: "REPORTED",
        },
      });
      const reservation = await db.providerBudgetReservation.findFirstOrThrow({
        where: { attemptId: original.attemptId },
      });
      expect(reservation.settledValue?.toString()).toBe("3");
      const ledger = await db.providerUsageLedger.findFirstOrThrow({
        where: { attemptId: original.attemptId },
      });
      expect(ledger).toMatchObject({ terminalReason: reason, billableTotal: 3n });
    },
  );
});
