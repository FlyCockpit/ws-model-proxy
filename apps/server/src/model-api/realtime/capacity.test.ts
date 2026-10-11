import { describe, expect, it, vi } from "vitest";
import type { CapacityAdmissionRuntime } from "../capacity/runtime.js";
import { createRealtimeAdmit, REALTIME_LEASE_MAX_LIFETIME_MS } from "./capacity.js";
import type { RealtimeCandidate } from "./transcription-session.js";

function candidate(
  route: Partial<NonNullable<RealtimeCandidate["route"]>> = {},
): RealtimeCandidate {
  return {
    nodeId: "node",
    handle: "i-aaaaaaaaaaaa",
    upstreamModel: "m",
    capabilities: null,
    memberId: "m1",
    route: {
      kind: "pool",
      poolId: "pool-1",
      poolMemberId: "m1",
      runtimeModelId: "rm",
      executionTargetId: "et",
      instanceId: "cap",
      ownerUserId: "owner",
      engineOwnerUserId: "owner",
      shareId: "share",
      contributedShareId: null,
      ...route,
    },
  };
}

function runtime(state: "ADMITTED" | "EXPIRED") {
  const signal = new AbortController().signal;
  const lease = {
    leaseId: "l",
    attemptId: "a",
    capacityId: "cap",
    executionTargetId: "et",
    fencingToken: 1n,
    expiresAt: new Date(),
    signal,
  };
  const fake = {
    acquire: vi.fn(async () => (state === "ADMITTED" ? { state, lease } : { state })),
    release: vi.fn(async () => true),
    hold: vi.fn(),
  };
  return { fake, lease, runtime: fake as unknown as CapacityAdmissionRuntime };
}

describe("realtime capacity admission", () => {
  it("takes one lease on the candidate's target with the session-long lifetime", async () => {
    const { fake, runtime: rt, lease } = runtime("ADMITTED");
    const admit = createRealtimeAdmit(rt);
    const signal = new AbortController().signal;
    const result = await admit(candidate(), signal);
    expect(fake.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner",
        sourceKind: "POOL",
        poolId: "pool-1",
        priorityShareId: "share",
        connectionOwner: "model-api-realtime",
        candidates: [
          expect.objectContaining({
            capacityId: "cap",
            executionTargetId: "et",
            poolMemberId: "m1",
            candidateOrder: 0,
          }),
        ],
      }),
      signal,
      { maxLeaseLifetimeMs: REALTIME_LEASE_MAX_LIFETIME_MS },
    );
    if (!result.ok) throw new Error("not admitted");
    expect(result.lease.signal).toBe(lease.signal);
    result.lease.release();
    result.lease.release();
    await Promise.resolve();
    expect(fake.release).toHaveBeenCalledTimes(1);
  });

  it("refuses when admission does not grant, or the member has no capacity identity", async () => {
    const { runtime: busy } = runtime("EXPIRED");
    expect(await createRealtimeAdmit(busy)(candidate(), new AbortController().signal)).toEqual({
      ok: false,
    });
    const { fake, runtime: rt } = runtime("ADMITTED");
    expect(
      await createRealtimeAdmit(rt)(candidate({ instanceId: "" }), new AbortController().signal),
    ).toEqual({ ok: false });
    expect(fake.acquire).not.toHaveBeenCalled();
  });

  it("admits a test target as TEST, without pool fields", async () => {
    const { fake, runtime: rt } = runtime("ADMITTED");
    await createRealtimeAdmit(rt)(
      candidate({ kind: "test", poolId: null, poolMemberId: null, shareId: null }),
      new AbortController().signal,
    );
    const [attempt] = fake.acquire.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(attempt.sourceKind).toBe("TEST");
    expect(attempt).not.toHaveProperty("poolId");
    expect(attempt).not.toHaveProperty("priorityShareId");
  });
});
