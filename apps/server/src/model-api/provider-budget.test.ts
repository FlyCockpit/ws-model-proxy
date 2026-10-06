import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  process.env.BETTER_AUTH_SECRET ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.SIGNUP_ENABLED ??= "true";
});

/**
 * In-memory stand-ins for the spend tables. Only what provider-budget.ts touches is modelled;
 * consumption follows the @ws-model-proxy/db/spend rules (latest SNAPSHOT plus later DELTAs,
 * in-flight = ACTIVE cloud attempts with no ledger revision, cap reservations).
 */
const state = vi.hoisted(() => {
  type Decimal = import("@ws-model-proxy/db").Prisma.Decimal;
  return {
    now: new Date("2026-10-06T12:00:00.000Z"),
    log: [] as string[],
    caps: [] as Array<{
      id: string;
      userId: string;
      scope: "PROVIDER_ACCOUNT" | "SHARE";
      providerAccountId: string | null;
      shareId: string | null;
      monthlyLimit: Decimal;
      currency: string;
      version: number;
    }>,
    models: [] as Array<{ id: string; userId: string; providerAccountId: string }>,
    pricing: [] as Array<{ providerModelId: string; version: string; currency: string }>,
    attempts: new Map<string, Record<string, unknown>>(),
    reservations: [] as Array<Record<string, unknown>>,
    settlements: [] as Array<Record<string, unknown>>,
    ledger: [] as Array<Record<string, unknown>>,
    failNextAttemptCreate: false,
  };
});

vi.mock("@ws-model-proxy/db", async () => {
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  let nextId = 0;
  const id = (prefix: string) => `${prefix}-${++nextId}`;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("clock_timestamp")) return Promise.resolve([{ now: state.now }]);
      if (text.includes("FROM attempt WHERE id") && text.includes("FOR UPDATE")) {
        state.log.push("lock:attempt");
        return Promise.resolve([]);
      }
      if (text.includes("wsmp_acquire_fences")) {
        state.log.push(`fences:${(values[0] as string[]).join(",")}`);
        return Promise.resolve([{ acquired: true }]);
      }
      throw new Error(`unexpected query ${text}`);
    },
    spendCap: {
      findMany: async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
        state.log.push("read:caps");
        const rows = state.caps.filter((cap) => where.OR.some((clause) => matches(cap, clause)));
        return rows.map(({ id, userId, scope, monthlyLimit, currency, version }) => ({
          id,
          userId,
          scope,
          monthlyLimit,
          currency,
          version,
        }));
      },
    },
    attempt: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.attempts.get(where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.log.push("write:attempt");
        if (state.failNextAttemptCreate) {
          state.failNextAttemptCreate = false;
          throw new Error("foreign key violation");
        }
        state.attempts.set(String(data.id), { state: "ACTIVE", ...data });
        return data;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = state.attempts.get(String(where.id));
        if (!row || !matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    providerModel: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        state.models.find((model) => model.id === where.id && model.userId === where.userId) ??
        null,
    },
    providerPricingVersion: {
      findFirst: async ({
        where,
      }: {
        where: { providerModelId: string; version: string; currency: string };
      }) =>
        state.pricing.find(
          (row) =>
            row.providerModelId === where.providerModelId &&
            row.version === where.version &&
            row.currency === where.currency,
        ) ?? null,
    },
    spendReservation: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        state.reservations.filter((row) => matches(row, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.log.push("write:reservation");
        const row = { id: id("reservation"), state: "RESERVED", ...data };
        state.reservations.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.reservations.find((item) => item.id === where.id);
        if (row?.state !== "RESERVED") throw new Error("a reservation only settles, once");
        Object.assign(row, data);
        return row;
      },
    },
    spendSettlement: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.settlements.push(data);
        return data;
      },
    },
    usageLedger: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        state.ledger.filter((row) => matches(row, where)).length,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        state.ledger.filter((row) => matches(row, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        state.ledger
          .filter((row) => matches(row, where))
          .sort((left, right) =>
            (left.revisionSequence as bigint) > (right.revisionSequence as bigint) ? -1 : 1,
          )[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (
          state.ledger.some(
            (row) =>
              row.attemptId === data.attemptId &&
              row.fencingToken === data.fencingToken &&
              row.revisionSequence === data.revisionSequence,
          )
        )
          throw new Error("unique violation");
        state.ledger.push(data);
        return data;
      },
    },
  };
  const client = {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    attempt: {
      ...tx.attempt,
      findMany: async ({ where }: { where: { expiresAt: { lte: Date } } }) =>
        [...state.attempts.values()].filter(
          (row) =>
            row.kind === "CLOUD" &&
            row.state === "ACTIVE" &&
            (row.expiresAt as Date).getTime() <= where.expiresAt.lte.getTime(),
        ),
    },
  };
  return { default: client, Prisma };
});

vi.mock("@ws-model-proxy/db/spend", async () => {
  const { Prisma } = await import("../../../../packages/db/prisma/generated/client");
  const zero = () => new Prisma.Decimal(0);
  const attemptTotal = (attemptId: unknown, fencingToken: unknown) => {
    const rows = state.ledger
      .filter((row) => row.attemptId === attemptId && row.fencingToken === fencingToken)
      .sort((left, right) =>
        (left.revisionSequence as bigint) < (right.revisionSequence as bigint) ? -1 : 1,
      );
    let total = zero();
    for (const row of rows) {
      const cost = (row.settledCost as InstanceType<typeof Prisma.Decimal> | null) ?? zero();
      total = row.revisionKind === "SNAPSHOT" ? cost : total.plus(cost);
    }
    return total;
  };
  /** Settled (ledger) plus in-flight (ACTIVE attempts without a ledger row) for a scope. */
  const usage = (key: "providerAccountId" | "shareId", value: string) => {
    const settledAttempts = new Set(
      state.ledger
        .filter((row) => row[key] === value)
        .map((row) => `${row.attemptId}|${row.fencingToken}`),
    );
    let spentThisMonth = zero();
    for (const entry of settledAttempts) {
      const [attemptId, token] = entry.split("|");
      spentThisMonth = spentThisMonth.plus(attemptTotal(attemptId, BigInt(token ?? "0")));
    }
    let reservedNow = zero();
    for (const attempt of state.attempts.values())
      if (
        attempt[key] === value &&
        attempt.kind === "CLOUD" &&
        attempt.state === "ACTIVE" &&
        !state.ledger.some(
          (row) => row.attemptId === attempt.id && row.fencingToken === attempt.fencingToken,
        )
      )
        reservedNow = reservedNow.plus(
          (attempt.liabilitySpend as InstanceType<typeof Prisma.Decimal> | null) ?? zero(),
        );
    return { spentThisMonth, reservedNow };
  };
  return {
    providerAccountSpend: async (_db: unknown, input: { providerAccountId: string }) => {
      state.log.push("read:account-usage");
      return usage("providerAccountId", input.providerAccountId);
    },
    shareSpend: async (_db: unknown, input: { shareId: string }) => {
      state.log.push("read:share-usage");
      return usage("shareId", input.shareId);
    },
  };
});

import { Prisma } from "@ws-model-proxy/db";
import {
  admitProviderBudget,
  type ProviderBudgetAttempt,
  ProviderBudgetConfigurationError,
  reconcileProviderBudget,
  repairExpiredProviderBudgets,
} from "./provider-budget.js";

const D = (value: string) => new Prisma.Decimal(value);
let sequence = 0;

function attempt(overrides: Partial<ProviderBudgetAttempt> = {}): ProviderBudgetAttempt {
  sequence += 1;
  return {
    userId: "owner",
    providerAccountId: "account",
    providerModelId: "model",
    credentialId: "credential",
    poolId: "pool",
    requestId: "relay-request",
    attemptId: `attempt-${sequence}`,
    fencingToken: BigInt(sequence),
    liability: {
      tokens: 1000n,
      spend: "1.00",
      currency: "USD",
      pricingVersion: "v1",
      accountingVersion: "provider-billable-v1",
    },
    expiresAt: new Date(state.now.getTime() + 15 * 60_000),
    ...overrides,
  };
}

function terminalFor(admitted: ProviderBudgetAttempt) {
  return {
    userId: admitted.userId,
    providerAccountId: admitted.providerAccountId,
    providerModelId: admitted.providerModelId,
    credentialId: admitted.credentialId,
    poolId: admitted.poolId,
    requestId: admitted.requestId,
    attemptId: admitted.attemptId,
    fencingToken: admitted.fencingToken,
  };
}

function capOnAccount(limit: string, currency = "USD") {
  state.caps.push({
    id: "cap-account",
    userId: "owner",
    scope: "PROVIDER_ACCOUNT",
    providerAccountId: "account",
    shareId: null,
    monthlyLimit: D(limit),
    currency,
    version: 3,
  });
}

function capOnShare(limit: string) {
  state.caps.push({
    id: "cap-share",
    userId: "owner",
    scope: "SHARE",
    providerAccountId: null,
    shareId: "share",
    monthlyLimit: D(limit),
    currency: "USD",
    version: 1,
  });
}

beforeEach(() => {
  state.now = new Date("2026-10-06T12:00:00.000Z");
  state.log.length = 0;
  state.caps.length = 0;
  state.models.splice(0, state.models.length, {
    id: "model",
    userId: "owner",
    providerAccountId: "account",
  });
  state.pricing.splice(0, state.pricing.length, {
    providerModelId: "model",
    version: "v1",
    currency: "USD",
  });
  state.attempts.clear();
  state.reservations.length = 0;
  state.settlements.length = 0;
  state.ledger.length = 0;
  state.failNextAttemptCreate = false;
});

describe("spend admission", () => {
  it("admits an uncapped attempt and anchors it as a CLOUD attempt without reservations", async () => {
    const input = attempt({ liability: { accountingVersion: "provider-billable-v1" } });
    await expect(admitProviderBudget(input)).resolves.toEqual({
      admitted: true,
      providerAttemptId: input.attemptId,
      reservationIds: [],
    });
    expect(state.attempts.get(input.attemptId)).toMatchObject({
      kind: "CLOUD",
      state: "ACTIVE",
      fencingToken: input.fencingToken,
      requestId: "relay-request",
      liabilitySpend: null,
    });
    expect(state.reservations).toEqual([]);
  });

  it("reserves against the account cap up to the limit, then refuses", async () => {
    capOnAccount("2.00");
    const first = attempt();
    const second = attempt();
    const third = attempt();
    expect((await admitProviderBudget(first)).admitted).toBe(true);
    // 1.00 reserved + 1.00 = 2.00: exactly at the cap is allowed.
    expect((await admitProviderBudget(second)).admitted).toBe(true);
    await expect(admitProviderBudget(third)).resolves.toEqual({
      admitted: false,
      reason: "BUDGET_EXCEEDED",
      capId: "cap-account",
    });
    expect(state.attempts.has(third.attemptId)).toBe(false);
    expect(state.reservations).toHaveLength(2);
    expect(state.reservations[0]).toMatchObject({
      capId: "cap-account",
      capVersion: 3,
      state: "RESERVED",
      reservedValue: D("1.00"),
      currency: "USD",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-01T00:00:00.000Z"),
    });
  });

  it("counts settled spend this month against the cap, and releases what was never sent", async () => {
    capOnAccount("1.50");
    const sent = attempt();
    await admitProviderBudget(sent);
    await reconcileProviderBudget({
      ...terminalFor(sent),
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        reportedCost: "0.40",
        currency: "USD",
        pricingVersion: "v1",
        observationComplete: true,
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
      },
    });
    const notSent = attempt();
    await admitProviderBudget(notSent);
    await reconcileProviderBudget({
      ...terminalFor(notSent),
      reason: "FAILED",
      dispatchOutcome: "NOT_SENT",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
    });
    // 0.40 settled + 0 released + 1.00 = 1.40 <= 1.50.
    expect((await admitProviderBudget(attempt())).admitted).toBe(true);
    // 0.40 + 1.00 reserved + 1.00 > 1.50.
    expect((await admitProviderBudget(attempt())).admitted).toBe(false);
  });

  it("fails closed when a cap applies but the attempt cannot be priced in its currency", async () => {
    capOnAccount("10");
    await expect(
      admitProviderBudget(attempt({ liability: { accountingVersion: "provider-billable-v1" } })),
    ).resolves.toMatchObject({ admitted: false, reason: "PRICING_UNAVAILABLE" });
    await expect(
      admitProviderBudget(
        attempt({
          liability: {
            spend: "1",
            currency: "EUR",
            pricingVersion: "v1",
            accountingVersion: "provider-billable-v1",
          },
        }),
      ),
    ).resolves.toMatchObject({ admitted: false, reason: "CURRENCY_UNAVAILABLE" });
    state.pricing.length = 0;
    await expect(admitProviderBudget(attempt())).resolves.toMatchObject({
      admitted: false,
      reason: "PRICING_UNAVAILABLE",
    });
    expect(state.attempts.size).toBe(0);
  });

  it("charges owner-paid share traffic against the share cap with grantee reasons", async () => {
    capOnShare("1.50");
    const shared = (overrides: Partial<ProviderBudgetAttempt> = {}) =>
      attempt({ shareId: "share", granteeUserId: "grantee", ...overrides });
    expect((await admitProviderBudget(shared())).admitted).toBe(true);
    await expect(admitProviderBudget(shared())).resolves.toEqual({
      admitted: false,
      reason: "GRANTEE_BUDGET_EXCEEDED",
      capId: "cap-share",
    });
    // The owner's own traffic is not bound by the share's cap.
    expect((await admitProviderBudget(attempt())).admitted).toBe(true);
    await expect(
      admitProviderBudget(shared({ liability: { accountingVersion: "provider-billable-v1" } })),
    ).resolves.toMatchObject({ admitted: false, reason: "GRANTEE_CAP_UNPRICEABLE" });
  });

  it("applies both caps to share traffic and reserves against each", async () => {
    capOnAccount("5");
    capOnShare("5");
    const input = attempt({ shareId: "share", granteeUserId: "grantee" });
    const admission = await admitProviderBudget(input);
    expect(admission.admitted && admission.reservationIds).toHaveLength(2);
    expect(state.reservations.map((row) => row.capId).sort()).toEqual(["cap-account", "cap-share"]);
  });

  it("takes the attempt and cap-subject fences before reading caps or writing", async () => {
    capOnAccount("5");
    capOnShare("5");
    await admitProviderBudget(attempt({ shareId: "share", attemptId: "fenced" }));
    expect(state.log.slice(0, 2)).toEqual([
      "fences:01:spend-attempt:fenced,04:spend-account:account,04:spend-share:share",
      "read:caps",
    ]);
    const firstWrite = state.log.findIndex((entry) => entry.startsWith("write:"));
    expect(firstWrite).toBeGreaterThan(state.log.indexOf("read:share-usage"));
  });

  it("serializes on the account even without a cap, so a cap created later counts it", async () => {
    const early = attempt({ attemptId: "early" });
    await admitProviderBudget(early);
    expect(state.log[0]).toBe("fences:01:spend-attempt:early,04:spend-account:account");
    // A cap appears while `early` is still in flight: its liability is reserved against it.
    capOnAccount("1.50");
    await expect(admitProviderBudget(attempt())).resolves.toMatchObject({
      admitted: false,
      reason: "BUDGET_EXCEEDED",
    });
  });

  it("counts the whole month of a share's spend when its cap is set mid-month", async () => {
    const shared = () => attempt({ shareId: "share", granteeUserId: "grantee" });
    const before = shared();
    await admitProviderBudget(before);
    await reconcileProviderBudget({
      ...terminalFor(before),
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
    });
    expect(state.ledger[0]).toMatchObject({ shareId: "share", settledCost: D("1.00") });
    capOnShare("1.50");
    await expect(admitProviderBudget(shared())).resolves.toMatchObject({
      admitted: false,
      reason: "GRANTEE_BUDGET_EXCEEDED",
    });
  });

  it("enforces a lowered cap (a version bump) on the next admission", async () => {
    capOnAccount("5");
    expect((await admitProviderBudget(attempt())).admitted).toBe(true);
    Object.assign(state.caps[0]!, { monthlyLimit: D("1.50"), version: 4 });
    await expect(admitProviderBudget(attempt())).resolves.toMatchObject({
      admitted: false,
      reason: "BUDGET_EXCEEDED",
    });
  });

  it("refuses (fail closed) when a cap on the subject is paid by someone else", async () => {
    capOnAccount("5");
    state.caps[0]!.userId = "grantee";
    await expect(admitProviderBudget(attempt())).rejects.toBeInstanceOf(
      ProviderBudgetConfigurationError,
    );
    expect(state.attempts.size).toBe(0);
  });

  it("replays an identical admission and refuses a conflicting one", async () => {
    capOnAccount("5");
    const input = attempt();
    const first = await admitProviderBudget(input);
    await expect(admitProviderBudget(input)).resolves.toEqual(first);
    await expect(
      admitProviderBudget({ ...input, liability: { ...input.liability, spend: "2" } }),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
  });

  it("throws instead of admitting on an accounting error (fail closed)", async () => {
    state.failNextAttemptCreate = true;
    await expect(admitProviderBudget(attempt())).rejects.toThrow("foreign key violation");
    state.models.length = 0;
    await expect(admitProviderBudget(attempt())).rejects.toBeInstanceOf(
      ProviderBudgetConfigurationError,
    );
    await expect(
      admitProviderBudget(
        attempt({ liability: { spend: "1", accountingVersion: "provider-billable-v1" } }),
      ),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
  });
});

describe("spend settlement", () => {
  async function admitted(overrides: Partial<ProviderBudgetAttempt> = {}) {
    capOnAccount("100");
    const input = attempt(overrides);
    const admission = await admitProviderBudget(input);
    expect(admission.admitted).toBe(true);
    return input;
  }

  it("releases a never-sent attempt at zero and ends it", async () => {
    const input = await admitted();
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "CANCELLED",
      dispatchOutcome: "NOT_SENT",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
    });
    expect(state.ledger).toEqual([
      expect.objectContaining({ settledCost: D("0"), costKnown: false, revisionSequence: 1n }),
    ]);
    // The attempt fence, then the attempt row (the heartbeat's row) before any write.
    expect(state.log.slice(-2)).toEqual([
      `fences:01:spend-attempt:${input.attemptId}`,
      "lock:attempt",
    ]);
    expect(state.reservations[0]).toMatchObject({ state: "SETTLED", settledValue: D("0") });
    expect(state.settlements[0]).toMatchObject({ settledValue: D("0"), reason: "CANCELLED" });
    expect(state.attempts.get(input.attemptId)).toMatchObject({
      state: "CANCELLED",
      terminalReason: "CANCELLED",
    });
  });

  it("settles a complete observation at its cost, an incomplete one at the liability", async () => {
    const complete = await admitted();
    await reconcileProviderBudget({
      ...terminalFor(complete),
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        calculatedCost: "0.25",
        currency: "USD",
        pricingVersion: "v1",
        observationComplete: true,
        accountingVersion: "provider-billable-v1",
        confidence: "CALCULATED",
      },
    });
    expect(state.ledger.at(-1)).toMatchObject({
      settledCost: D("0.25"),
      costKnown: true,
      currency: "USD",
      pricingVersion: "v1",
      confidence: "CALCULATED",
    });
    expect(state.attempts.get(complete.attemptId)?.state).toBe("COMPLETED");

    const truncated = attempt();
    await admitProviderBudget(truncated);
    await reconcileProviderBudget({
      ...terminalFor(truncated),
      reason: "FAILED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        reportedCost: "0.01",
        currency: "USD",
        pricingVersion: "v1",
        observationComplete: false,
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
      },
    });
    expect(state.ledger.at(-1)).toMatchObject({
      settledCost: D("1.00"),
      costKnown: false,
    });
  });

  it("ignores a cost in another price or currency (keeps the liability)", async () => {
    const input = await admitted();
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: {
        reportedCost: "0.01",
        currency: "EUR",
        pricingVersion: "v1",
        observationComplete: true,
        accountingVersion: "provider-billable-v1",
        confidence: "REPORTED",
      },
    });
    expect(state.ledger[0]).toMatchObject({ settledCost: D("1.00"), costKnown: false });
  });

  it("appends corrections: a DELTA adds, an unknown DELTA tops up to the liability", async () => {
    const input = await admitted();
    const known = (cost: string) => ({
      reportedCost: cost,
      currency: "USD",
      pricingVersion: "v1",
      observationComplete: true,
      accountingVersion: "provider-billable-v1",
      confidence: "REPORTED" as const,
    });
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "COMPLETED",
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      usage: known("0.30"),
    });
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "COMPLETED",
      revisionSequence: 2n,
      revisionKind: "DELTA",
      usage: known("0.05"),
    });
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "COMPLETED",
      revisionSequence: 3n,
      revisionKind: "DELTA",
    });
    expect(state.ledger.map((row) => String(row.settledCost))).toEqual(["0.3", "0.05", "0.65"]);
    // The reservation settled once, at the first total; later revisions are settlements.
    expect(state.reservations[0]).toMatchObject({ state: "SETTLED", settledValue: D("0.30") });
    expect(state.settlements.map((row) => row.revisionKind)).toEqual([
      "SNAPSHOT",
      "DELTA",
      "DELTA",
    ]);
  });

  it("treats a duplicate revision as a no-op and a changed one as a conflict", async () => {
    const input = await admitted();
    const terminal = {
      ...terminalFor(input),
      reason: "FAILED" as const,
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT" as const,
    };
    await reconcileProviderBudget(terminal);
    await reconcileProviderBudget(terminal);
    expect(state.ledger).toHaveLength(1);
    await expect(
      reconcileProviderBudget({ ...terminal, reason: "COMPLETED" }),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
    await expect(
      reconcileProviderBudget({ ...terminal, revisionSequence: 0n }),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
  });

  it("refuses to settle an attempt that was never admitted or under another identity", async () => {
    const input = await admitted();
    await expect(
      reconcileProviderBudget({
        ...terminalFor(input),
        fencingToken: input.fencingToken + 100n,
        reason: "FAILED",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
    await expect(
      reconcileProviderBudget({
        ...terminalFor(input),
        providerModelId: "other-model",
        reason: "FAILED",
        revisionSequence: 1n,
        revisionKind: "SNAPSHOT",
      }),
    ).rejects.toBeInstanceOf(ProviderBudgetConfigurationError);
    expect(state.ledger).toEqual([]);
  });
});

describe("crash repair", () => {
  it("settles an expired attempt at its liability and expires it", async () => {
    capOnAccount("100");
    const input = attempt();
    await admitProviderBudget(input);
    const later = new Date(state.now.getTime() + 16 * 60_000);
    // The sweeping replica's clock alone is not enough: the database clock decides.
    await repairExpiredProviderBudgets(later);
    expect(state.ledger).toEqual([]);
    expect(state.attempts.get(input.attemptId)?.state).toBe("ACTIVE");
    state.now = later;
    await expect(repairExpiredProviderBudgets(later)).resolves.toBe(1);
    expect(state.ledger[0]).toMatchObject({
      settledCost: D("1.00"),
      terminalReason: "CRASH_RECOVERY",
      revisionSequence: 0n,
    });
    expect(state.attempts.get(input.attemptId)?.state).toBe("EXPIRED");
    expect(state.reservations[0]?.state).toBe("SETTLED");
  });

  it("leaves an attempt its heartbeat renewed after the sweep selected it", async () => {
    const input = attempt();
    await admitProviderBudget(input);
    await reconcileProviderBudget({
      ...terminalFor(input),
      reason: "CRASH_RECOVERY",
      crashExpiredAt: new Date(state.now.getTime() + 60_000),
      revisionSequence: 0n,
      revisionKind: "SNAPSHOT",
    });
    expect(state.ledger).toEqual([]);
    expect(state.attempts.get(input.attemptId)?.state).toBe("ACTIVE");
  });

  it("only ends the state of an expired attempt that already has a ledger revision", async () => {
    const input = attempt();
    await admitProviderBudget(input);
    state.ledger.push({
      attemptId: input.attemptId,
      fencingToken: input.fencingToken,
      revisionSequence: 1n,
      revisionKind: "SNAPSHOT",
      settledCost: D("0.2"),
      terminalReason: "COMPLETED",
    });
    await repairExpiredProviderBudgets(new Date(state.now.getTime() + 16 * 60_000));
    expect(state.ledger).toHaveLength(1);
    expect(state.attempts.get(input.attemptId)?.state).toBe("COMPLETED");
  });
});
