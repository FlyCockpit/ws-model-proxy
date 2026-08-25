import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ publicProviderAttemptEvent: { create: vi.fn() } }));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));

import {
  classifyProviderFailure,
  parseRetryAfter,
  recordProviderAttemptEvent,
} from "./provider-attempt-runtime.js";

describe("provider attempt failure policy", () => {
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
