import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));

import prisma from "@ws-model-proxy/db";
import {
  type PoolRouteRow,
  recordTargetRelayFailure,
  routablePoolRoutes,
  targetHealthFailure,
} from "./pool-routing";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const now = new Date("2026-10-07T12:00:00Z");
const past = new Date(now.getTime() - 1_000);
const future = new Date(now.getTime() + 60_000);

function route(id: string, overrides: Partial<PoolRouteRow> = {}): PoolRouteRow {
  return {
    poolMemberId: `member-${id}`,
    poolId: "pool",
    runtimeModelId: `model-${id}`,
    upstreamModelId: "qwen",
    executionTargetId: `target-${id}`,
    instanceId: `instance-${id}`,
    instanceHandle: `wrap-${id}`,
    nodeId: "node",
    instanceReady: true,
    nodeOnline: true,
    memberActive: true,
    weight: 1,
    health: "HEALTHY",
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
    ...overrides,
  };
}

const degraded = (id: string, nextRetryAt = past): PoolRouteRow =>
  route(id, {
    health: "DEGRADED",
    lastFailureClass: "UPSTREAM_5XX",
    consecutiveRetryableFailures: 1,
    lastFailureAt: past,
    nextRetryAt,
  });

const routable = (routes: PoolRouteRow[]) =>
  routablePoolRoutes({ routes, onlineNodeIds: ["node"], now }).map((candidate) => [
    candidate.executionTargetId,
    candidate.health,
    candidate.degradedFallback,
  ]);

beforeEach(() => mockReset(db));

describe("routing around degraded targets", () => {
  it("leaves a degraded target to its probe while a healthy one can serve", () => {
    expect(routable([route("a"), degraded("b")])).toEqual([["target-a", "HEALTHY", false]]);
  });

  it("gives every due degraded target a half-open request when none is healthy", () => {
    // Two members of one pool, both degraded by one bad request: the pool must not answer
    // 503 forever while both engines are fine.
    expect(routable([degraded("a"), degraded("b")])).toEqual([
      ["target-a", "HALF_OPEN", true],
      ["target-b", "HALF_OPEN", true],
    ]);
    // Not before its backoff has passed.
    expect(routable([degraded("a", future), degraded("b")])).toEqual([
      ["target-b", "HALF_OPEN", true],
    ]);
  });

  it("does not count a healthy route that cannot serve as an alternative", () => {
    expect(routable([route("a", { nodeOnline: false }), degraded("b")])).toEqual([
      ["target-b", "HALF_OPEN", true],
    ]);
    expect(routable([route("a", { memberActive: false }), degraded("b")])).toEqual([
      ["target-b", "HALF_OPEN", true],
    ]);
  });
});

describe("what a failed attempt says about its target", () => {
  it("never counts an adapted request's upstream 5xx or translation failure", () => {
    expect(targetHealthFailure("upstream_5xx", true)).toBe("unknown");
    expect(targetHealthFailure("protocol_error", true)).toBe("unknown");
    // Unreachable is unreachable, translated or not.
    expect(targetHealthFailure("transport", true)).toBe("transport");
    expect(targetHealthFailure("timeout", true)).toBe("timeout");
    // A native request's 5xx still counts.
    expect(targetHealthFailure("upstream_5xx", false)).toBe("upstream_5xx");
  });

  it("writes no health for an uncounted failure and gives its half-open trial back", async () => {
    db.executionTarget.updateMany.mockResolvedValue({ count: 1 });
    const result = await recordTargetRelayFailure({
      executionTargetId: "target-a",
      failure: targetHealthFailure("upstream_5xx", true),
      trialStartedAt: past,
      now,
    });
    expect(result).toEqual({ retryable: false, update: null });
    expect(db.executionTarget.findUnique).not.toHaveBeenCalled();
    expect(db.executionTarget.updateMany).toHaveBeenCalledWith({
      where: { id: "target-a", health: "HALF_OPEN", halfOpenTrialStartedAt: past },
      data: { halfOpenTrialStartedAt: null },
    });
  });
});
