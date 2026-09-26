import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  providerAttempt: { findUnique: vi.fn(), updateMany: vi.fn() },
  providerUsageLedger: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
  providerBudgetReservation: { findMany: vi.fn(), update: vi.fn() },
  providerBudgetSettlement: { aggregate: vi.fn(), create: vi.fn() },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  return {
    Prisma,
    default: { $transaction: async (work: (client: typeof tx) => unknown) => work(tx) },
  };
});

import { Prisma } from "@ws-model-proxy/db";
import { type ProviderBudgetTerminal, reconcileProviderBudget } from "./provider-budget.js";

const terminal = (dispatchOutcome?: "NOT_SENT"): ProviderBudgetTerminal => ({
  userId: "owner",
  providerAccountId: "account",
  providerModelId: "model",
  requestId: "request",
  attemptId: "attempt",
  fencingToken: 1n,
  reason: "FAILED",
  revisionSequence: 1n,
  revisionKind: "SNAPSHOT",
  dispatchOutcome,
});

beforeEach(() => {
  vi.clearAllMocks();
  tx.providerAttempt.findUnique.mockResolvedValue({
    ...terminal(),
    id: "anchor",
    state: "ACTIVE",
    poolId: null,
    credentialId: null,
    accountingVersion: "provider-billable-v1",
    pricingVersion: "price-1",
    liabilityCurrency: "USD",
    expiresAt: new Date(0),
  });
  tx.providerAttempt.updateMany.mockResolvedValue({ count: 1 });
  tx.providerUsageLedger.findUnique.mockResolvedValue(null);
  tx.providerUsageLedger.findMany.mockResolvedValue([]);
  tx.providerBudgetReservation.findMany.mockResolvedValue([
    {
      id: "tokens",
      policyId: "policy",
      metric: "TOKENS",
      state: "RESERVED",
      reservedValue: new Prisma.Decimal(100),
    },
    {
      id: "spend",
      policyId: "policy",
      metric: "SPEND",
      state: "RESERVED",
      currency: "USD",
      reservedValue: new Prisma.Decimal("0.75"),
    },
    {
      id: "concurrency",
      policyId: "policy",
      metric: "CONCURRENCY",
      state: "RESERVED",
      reservedValue: new Prisma.Decimal(1),
    },
  ]);
  tx.providerBudgetSettlement.aggregate.mockResolvedValue({ _sum: { settledValue: null } });
});

function settledAmounts() {
  return tx.providerBudgetSettlement.create.mock.calls.map(([input]) => [
    input.data.reservationId,
    input.data.settledValue.toString(),
  ]);
}

describe("durable provider budget reconciliation", () => {
  it.each(["FAILED", "CANCELLED", "TIMEOUT"] as const)(
    "settles a never-sent %s attempt at zero for every metric",
    async (reason) => {
      await reconcileProviderBudget({ ...terminal("NOT_SENT"), reason });
      expect(settledAmounts()).toEqual([
        ["tokens", "0"],
        ["spend", "0"],
        ["concurrency", "0"],
      ]);
      expect(
        tx.providerBudgetReservation.update.mock.calls.map(([input]) =>
          input.data.settledValue.toString(),
        ),
      ).toEqual(["0", "0", "0"]);
      expect(tx.providerAttempt.updateMany).toHaveBeenCalledOnce();
    },
  );

  it("keeps the full liability when transport may have sent bytes but usage is unknown", async () => {
    await reconcileProviderBudget(terminal());
    expect(settledAmounts()).toEqual([
      ["tokens", "100"],
      ["spend", "0.75"],
      ["concurrency", "0"],
    ]);
  });

  it("settles a completed authoritative observation to actual usage", async () => {
    await reconcileProviderBudget({
      ...terminal(),
      reason: "COMPLETED",
      observationComplete: true,
      usage: {
        authoritativeBillableTokens: 12n,
        reportedCost: "0.03",
        currency: "USD",
        pricingVersion: "price-1",
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
      },
    });
    expect(settledAmounts()).toEqual([
      ["tokens", "12"],
      ["spend", "0.03"],
      ["concurrency", "0"],
    ]);
  });

  it("terminalizes attempts with no budget reservations", async () => {
    tx.providerBudgetReservation.findMany.mockResolvedValue([]);
    await reconcileProviderBudget(terminal("NOT_SENT"));
    expect(tx.providerBudgetSettlement.create).not.toHaveBeenCalled();
    expect(tx.providerAttempt.updateMany).toHaveBeenCalledOnce();
  });

  it("persists an idempotent zero revision that crash repair cannot replace", async () => {
    await reconcileProviderBudget(terminal("NOT_SENT"));
    const data = tx.providerUsageLedger.create.mock.calls[0]?.[0].data;
    tx.providerUsageLedger.findUnique.mockResolvedValue(data);
    await reconcileProviderBudget(terminal("NOT_SENT"));
    expect(tx.providerBudgetSettlement.create).toHaveBeenCalledTimes(3);
    await expect(reconcileProviderBudget(terminal())).rejects.toThrow("revision conflict");
    tx.providerUsageLedger.findUnique.mockResolvedValue(null);
    tx.providerUsageLedger.findMany.mockResolvedValue([{ revisionSequence: 1n }]);
    await reconcileProviderBudget({ ...terminal(), reason: "CRASH_RECOVERY" });
    expect(tx.providerBudgetSettlement.create).toHaveBeenCalledTimes(3);
  });

  it("does not accept not-sent proof mixed with provider usage", async () => {
    await expect(
      reconcileProviderBudget({
        ...terminal("NOT_SENT"),
        usage: {
          authoritativeBillableTokens: 1n,
          accountingVersion: "provider-billable-v1",
          confidence: "REPORTED",
        },
      }),
    ).rejects.toThrow("Not-sent settlement");
    expect(tx.providerBudgetSettlement.create).not.toHaveBeenCalled();
  });
});
