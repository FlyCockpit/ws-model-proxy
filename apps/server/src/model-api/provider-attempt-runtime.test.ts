import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  publicProviderAttemptEvent: { create: vi.fn() },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));

import {
  claimProviderHealthTrial,
  classifyProviderFailure,
  heartbeatProviderAttempt,
  parseRetryAfter,
  recordProviderAttemptEvent,
  recordProviderOutcome,
  releaseProviderHealthTrial,
} from "./provider-attempt-runtime.js";

describe("provider attempt failure policy", () => {
  it("renews only the fenced account and model half-open owner", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "owner",
          providerAccountId: "account",
          providerModelId: "model",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "attempt",
          healthHalfOpenFencingToken: 7n,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "attempt",
          healthHalfOpenFencingToken: 7n,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      heartbeatProviderAttempt({ attemptId: "attempt", fencingToken: 7n, extensionMs: 900_000 }),
    ).resolves.toBe(true);
    expect(tx.providerAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: "account",
        userId: "owner",
        healthHalfOpenAttemptId: "attempt",
        healthHalfOpenFencingToken: 7n,
      },
      data: { healthHalfOpenAt: expect.any(Date) },
    });
    expect(tx.providerModel.updateMany).toHaveBeenCalledWith({
      where: {
        id: "model",
        userId: "owner",
        healthHalfOpenAttemptId: "attempt",
        healthHalfOpenFencingToken: 7n,
      },
      data: { healthHalfOpenAt: expect.any(Date) },
    });
  });

  it("rejects an orphan heartbeat after a successor fence is installed", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "owner",
          providerAccountId: "account",
          providerModelId: "model",
        }),
        updateMany: vi.fn(),
      },
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "successor",
          healthHalfOpenFencingToken: 8n,
        }),
        updateMany: vi.fn(),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "successor",
          healthHalfOpenFencingToken: 8n,
        }),
        updateMany: vi.fn(),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      heartbeatProviderAttempt({ attemptId: "orphan", fencingToken: 7n, extensionMs: 900_000 }),
    ).resolves.toBe(false);
    expect(tx.providerAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.providerModel.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [408, "TIMEOUT"],
    [409, "CONFLICT"],
    [429, "RATE_LIMIT"],
    [500, "SERVER"],
    [599, "SERVER"],
    [400, "PROTOCOL"],
    [undefined, "TRANSPORT"],
  ] as const)("classifies status %s", (status, expected) => {
    expect(classifyProviderFailure(status)).toBe(expected);
  });

  it("parses delta seconds and clamps retry-after dates", () => {
    expect(parseRetryAfter("12", 0)).toBe(12_000);
    expect(parseRetryAfter("Wed, 01 Jan 2025 00:01:00 GMT", Date.UTC(2025, 0, 1))).toBe(60_000);
    expect(parseRetryAfter("999999", 0)).toBe(300_000);
    expect(parseRetryAfter("invalid", 0)).toBeUndefined();
  });

  it("persists provider-directed cooldowns for a terminal rate-limit response", async () => {
    const now = new Date("2026-08-25T00:00:00.000Z");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ healthFailureCount: 0 }),
        update: vi.fn().mockResolvedValue({}),
      },
      providerAccount: {
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ healthFailureCount: 0, healthNextRetryAt: null }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await recordProviderOutcome({
      userId: "owner",
      providerAccountId: "account",
      providerModelId: "model",
      success: false,
      failureClass: "RATE_LIMIT",
      retryAfterMs: 45_000,
      now,
    });

    expect(tx.providerModel.update).toHaveBeenCalledWith({
      where: { id: "model", userId: "owner" },
      data: expect.objectContaining({
        healthStatus: "DEGRADED",
        healthNextRetryAt: new Date("2026-08-25T00:00:45.000Z"),
      }),
    });
    expect(tx.providerAccount.update).toHaveBeenCalledWith({
      where: { id: "account", userId: "owner" },
      data: expect.objectContaining({
        healthStatus: "DEGRADED",
        healthNextRetryAt: new Date("2026-08-25T00:00:45.000Z"),
      }),
    });
  });

  it("rejects a delayed older outcome after a successor clears its owner fields", async () => {
    const completedSuccessor = {
      healthFailureCount: 0,
      healthNextRetryAt: null,
      healthHalfOpenAttemptId: null,
      healthHalfOpenFencingToken: null,
      healthFencingWatermark: 8n,
    };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(completedSuccessor),
        update: vi.fn(),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(completedSuccessor),
        update: vi.fn(),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await recordProviderOutcome({
      userId: "owner",
      providerAccountId: "account",
      providerModelId: "model",
      attemptId: "late-a",
      fencingToken: 7n,
      success: false,
    });

    expect(tx.providerAccount.update).not.toHaveBeenCalled();
    expect(tx.providerModel.update).not.toHaveBeenCalled();
  });

  it("advances the durable watermark when a concurrent READY attempt records an outcome", async () => {
    const healthy = {
      healthFailureCount: 0,
      healthNextRetryAt: null,
      healthHalfOpenAttemptId: null,
      healthHalfOpenFencingToken: null,
      healthFencingWatermark: 4n,
    };
    const tx = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
        const sql = parts.join("");
        if (sql.includes("SELECT EXISTS")) return [{ eligible: true }];
        return sql.includes("FROM provider_attempt") ? [{ id: "durable-attempt" }] : [];
      }),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(healthy),
        update: vi.fn().mockResolvedValue({}),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(healthy),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await recordProviderOutcome({
      userId: "owner",
      providerAccountId: "account",
      providerModelId: "model",
      attemptId: "ready-newer",
      fencingToken: 9n,
      success: true,
    });

    expect(tx.providerModel.update).toHaveBeenCalledWith({
      where: { id: "model", userId: "owner" },
      data: expect.objectContaining({ healthFencingWatermark: 9n }),
    });
    expect(tx.providerAccount.update).toHaveBeenCalledWith({
      where: { id: "account", userId: "owner" },
      data: expect.objectContaining({ healthFencingWatermark: 9n }),
    });
    expect(
      tx.$queryRaw.mock.calls.some(([parts]) =>
        (parts as unknown as TemplateStringsArray)
          .join("")
          .includes('"expiresAt" > clock_timestamp()'),
      ),
    ).toBe(true);
  });

  it("rejects a fenced outcome when its durable attempt is no longer active", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAccount: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
      providerModel: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      recordProviderOutcome({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model",
        attemptId: "expired",
        fencingToken: 11n,
        success: false,
      }),
    ).resolves.toBe(false);
    expect(tx.providerAccount.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(tx.providerModel.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("locks the account before the model and enforces an account cooldown", async () => {
    const locks: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
        locks.push(parts.join("?"));
        return [];
      }),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: new Date("2026-08-25T00:01:00.000Z"),
          healthHalfOpenAt: null,
        }),
        update: vi.fn(),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: null,
          healthHalfOpenAt: null,
        }),
        update: vi.fn(),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      claimProviderHealthTrial({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model-b",
        attemptId: "attempt-b",
        fencingToken: 2n,
        now: new Date("2026-08-25T00:00:00.000Z"),
      }),
    ).resolves.toBe("COOLDOWN");
    expect(locks[0]).toContain("provider_account");
    expect(locks[1]).toContain("provider_model");
    expect(tx.providerModel.update).not.toHaveBeenCalled();
  });

  it("atomically reclaims stale account and model half-open leases", async () => {
    const now = new Date("2026-08-25T00:02:00.000Z");
    const stale = new Date("2026-08-25T00:00:59.999Z");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: new Date("2026-08-25T00:00:30.000Z"),
          healthHalfOpenAt: stale,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: new Date("2026-08-25T00:00:30.000Z"),
          healthHalfOpenAt: stale,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      claimProviderHealthTrial({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model",
        attemptId: "attempt-new",
        fencingToken: 3n,
        now,
      }),
    ).resolves.toBe("HALF_OPEN");
    expect(tx.providerAccount.update).toHaveBeenCalledWith({
      where: { id: "account", userId: "owner" },
      data: {
        healthHalfOpenAt: now,
        healthHalfOpenAttemptId: "attempt-new",
        healthHalfOpenFencingToken: 3n,
        healthFencingWatermark: 3n,
      },
    });
    expect(tx.providerModel.update).toHaveBeenCalledWith({
      where: { id: "model", userId: "owner" },
      data: {
        healthHalfOpenAt: now,
        healthHalfOpenAttemptId: "attempt-new",
        healthHalfOpenFencingToken: 3n,
        healthFencingWatermark: 3n,
      },
    });
  });

  it("releases only the exact owner without clearing cooldown or the durable fence", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "attempt",
          healthHalfOpenFencingToken: 7n,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthHalfOpenAttemptId: "attempt",
          healthHalfOpenFencingToken: 7n,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      releaseProviderHealthTrial({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model",
        attemptId: "attempt",
        fencingToken: 7n,
      }),
    ).resolves.toBe(true);
    expect(tx.providerAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: "account",
        userId: "owner",
        healthHalfOpenAttemptId: "attempt",
        healthHalfOpenFencingToken: 7n,
      },
      data: {
        healthHalfOpenAt: null,
        healthHalfOpenAttemptId: null,
        healthHalfOpenFencingToken: null,
      },
    });
  });

  it("does not steal a live half-open lease", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      providerAccount: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: new Date("2026-08-25T00:00:30.000Z"),
          healthHalfOpenAt: new Date("2026-08-25T00:01:30.001Z"),
        }),
        update: vi.fn(),
      },
      providerModel: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          healthNextRetryAt: new Date("2026-08-25T00:00:30.000Z"),
          healthHalfOpenAt: null,
        }),
        update: vi.fn(),
      },
    };
    db.$transaction.mockImplementationOnce(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await expect(
      claimProviderHealthTrial({
        userId: "owner",
        providerAccountId: "account",
        providerModelId: "model",
        attemptId: "attempt-new",
        fencingToken: 3n,
        now: new Date("2026-08-25T00:02:00.000Z"),
      }),
    ).resolves.toBe("COOLDOWN");
    expect(tx.providerAccount.update).not.toHaveBeenCalled();
    expect(tx.providerModel.update).not.toHaveBeenCalled();
  });

  it("persists a prompt-free, fully correlated append-only attempt event", async () => {
    const firstClientByteAt = new Date("2026-08-25T00:00:00.000Z");
    await recordProviderAttemptEvent({
      userId: "owner",
      providerAccountId: "account",
      providerModelId: "model",
      providerAttemptId: "anchor",
      requestId: "request",
      attemptId: "attempt",
      fencingToken: 17n,
      eventType: "FIRST_CLIENT_BYTE",
      reason: "RESPONSE_COMMITTED",
      requestedSurface: "openai-responses",
      nativeSurface: "anthropic-messages",
      adapterMode: "adapted",
      adapterVersion: "1.0.0",
      poolId: "pool",
      poolMemberId: "member",
      executionTargetId: "target",
      memberTier: "PUBLIC_OVERFLOW",
      triggerReason: "LOCAL_WAIT_EXPIRED",
      affinityOutcome: "NONE",
      contextCountMethod: "serialized_estimate",
      contextCountConfidence: "ESTIMATED",
      contextTokens: 123n,
      waitDurationMs: 9,
      reservationId: "reservation-a",
      reservationIds: ["reservation-a", "reservation-b"],
      firstClientByteAt,
      streamCommitted: true,
    });

    expect(db.publicProviderAttemptEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        attemptId: "attempt",
        fencingToken: 17n,
        poolMemberId: "member",
        executionTargetId: "target",
        reservationIds: ["reservation-a", "reservation-b"],
        firstClientByteAt,
        streamCommitted: true,
      }),
    });
  });
});
