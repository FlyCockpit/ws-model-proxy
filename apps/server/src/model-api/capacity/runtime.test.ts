import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {}, Prisma: {} }));

import {
  CAPACITY_LEASE_MAX_LIFETIME_MS,
  CapacityLeaseLostError,
  isCapacityLeaseLost,
} from "./lease-owner.js";
import { StoreCapacityAdmissionRuntime } from "./runtime.js";
import type { CapacityAdmissionStore, CapacityLeaseHandle } from "./types.js";

describe("capacity admission runtime", () => {
  it("rejects polling intervals that cannot safely refresh waiting heartbeats", () => {
    expect(() => new StoreCapacityAdmissionRuntime({} as never, 10_001)).toThrow(/poll interval/i);
  });
  it("polls one durable attempt with candidates only on initial enqueue", async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({ state: "WAITING", requestId: "request" })
      .mockResolvedValueOnce({ state: "CANCELLED" });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire,
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire({
        requestId: "request",
        attemptId: "attempt",
        ownerId: "owner",
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "server",
        deadlineAt: new Date(Date.now() + 100),
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(acquire.mock.calls[1]?.[0].candidates).toEqual([]);
  });

  it("runs bounded request-scoped maintenance once per interval", async () => {
    const sweepAbandoned = vi.fn().mockResolvedValue({ requests: 0, leases: 0 });
    const store = {
      acquire: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
      release: vi.fn(),
      heartbeat: vi.fn(),
      terminalizeAttempt: vi.fn().mockResolvedValue({ state: "CANCELLED" }),
      reclaimExpired: vi.fn(),
      sweepAbandoned,
    };
    const runtime = new StoreCapacityAdmissionRuntime(store, 1, 60_000);
    const attempt = {
      requestId: "request",
      attemptId: "attempt",
      ownerId: "owner",
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: "server",
      deadlineAt: new Date(Date.now() + 100),
      candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
    };
    await runtime.acquire(attempt);
    await runtime.acquire({ ...attempt, attemptId: "attempt-2" });
    expect(sweepAbandoned).toHaveBeenCalledTimes(1);
  });

  it("durably cancels an aborted waiter before returning", async () => {
    const controller = new AbortController();
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "CANCELLED" });
    const acquire = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { state: "WAITING", requestId: "request" };
    });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire,
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "CANCELLED");
  });

  it("releases admission when abort wins immediately after acquire", async () => {
    const controller = new AbortController();
    const lease = {
      leaseId: "lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const release = vi.fn().mockResolvedValue(true);
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { state: "ADMITTED", lease };
        }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "ADMITTED", lease }),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("returns durable expiry when abort races a database-expired attempt after acquire", async () => {
    const controller = new AbortController();
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "EXPIRED" });
    const release = vi.fn();
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { state: "CANCELLED" };
        }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
    );

    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "EXPIRED" });
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "CANCELLED");
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a lease that atomically wins against waiter cancellation", async () => {
    const controller = new AbortController();
    const lease = {
      leaseId: "race-lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 2n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const release = vi.fn().mockResolvedValue(true);
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockImplementation(async () => {
          controller.abort();
          return { state: "WAITING", requestId: "request" };
        }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt: vi.fn().mockResolvedValue({ state: "ADMITTED", lease }),
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 100),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).resolves.toEqual({ state: "CANCELLED" });
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("durably expires a waiter at its deadline", async () => {
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "EXPIRED" });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockResolvedValue({ state: "WAITING", requestId: "request" }),
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire({
        requestId: "request",
        attemptId: "attempt",
        ownerId: "owner",
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "server",
        deadlineAt: new Date(Date.now() + 5),
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).resolves.toEqual({ state: "EXPIRED" });
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "EXPIRED");
  });

  it("keeps polling when a fast local clock reaches the deadline before the store", async () => {
    const terminalizeAttempt = vi
      .fn()
      .mockResolvedValueOnce({ state: "WAITING", requestId: "request" })
      .mockResolvedValueOnce({ state: "EXPIRED" });
    const acquire = vi.fn().mockResolvedValue({ state: "WAITING", requestId: "request" });
    const deadlineAt = new Date(Date.now() + 60_000);
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire,
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
      5_000,
      undefined,
      () => deadlineAt.getTime() + 60_000,
    );

    await expect(
      runtime.acquire({
        requestId: "request",
        attemptId: "attempt",
        ownerId: "owner",
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "server",
        deadlineAt,
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).resolves.toEqual({ state: "EXPIRED" });
    expect(terminalizeAttempt).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("releases a raced-and-won lease when the acquisition throws (catch boundary, G2n pass 5)", async () => {
    // The R69/R70 probe: initial WAITING, the poll aborts and throws, and
    // terminalizeAttempt returns ADMITTED with an ACTIVE lease (admission
    // won the race under the same capacity locks). The catch boundary must
    // RELEASE that lease before rethrowing — mirroring the normal branches
    // — or the slot leaks until reclamation.
    const controller = new AbortController();
    const lease = {
      leaseId: "raced-lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 3n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    const pollFailure = new Error("poll aborted");
    const release = vi.fn().mockResolvedValue(true);
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "ADMITTED", lease });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi
          .fn()
          .mockResolvedValueOnce({ state: "WAITING", requestId: "request" })
          .mockImplementationOnce(async () => {
            controller.abort();
            throw pollFailure;
          }),
        release,
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
      },
      1,
    );
    await expect(
      runtime.acquire(
        {
          requestId: "request",
          attemptId: "attempt",
          ownerId: "owner",
          sourceKind: "DIRECT",
          basePriority: 16,
          connectionOwner: "server",
          deadlineAt: new Date(Date.now() + 60_000),
          candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
        },
        controller.signal,
      ),
    ).rejects.toBe(pollFailure);
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "CANCELLED");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(lease);
  });

  it("a maintain() failure is inside the acquisition-failure boundary: the attempt still terminalizes (G2n pass 5)", async () => {
    // maintain() previously sat OUTSIDE the try — a sweep failure escaped
    // without terminalizing a persisted WAITING attempt. The boundary is
    // now unconditional over the acquisition flow (maintain + poll).
    const maintainFailure = new Error("sweep failed");
    const terminalizeAttempt = vi.fn().mockResolvedValue({ state: "EXPIRED" });
    const runtime = new StoreCapacityAdmissionRuntime(
      {
        acquire: vi.fn().mockResolvedValue({ state: "WAITING", requestId: "request" }),
        release: vi.fn(),
        heartbeat: vi.fn(),
        terminalizeAttempt,
        reclaimExpired: vi.fn(),
        sweepAbandoned: vi.fn().mockRejectedValue(maintainFailure),
      },
      1,
    );
    await expect(
      runtime.acquire({
        requestId: "request",
        attemptId: "attempt",
        ownerId: "owner",
        sourceKind: "DIRECT",
        basePriority: 16,
        connectionOwner: "server",
        deadlineAt: new Date(Date.now() + 60_000),
        candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
      }),
    ).rejects.toBe(maintainFailure);
    // No signal abort → the catch terminal state is EXPIRED.
    expect(terminalizeAttempt).toHaveBeenCalledWith("attempt", "EXPIRED");
  });
});

// F2-CAP-1: model admission precedes dispatch, which may wait longer than the
// original 30s TTL before there is a Response to wrap.
describe("admitted lease ownership", () => {
  function fixture() {
    const lease = {
      leaseId: "lease",
      attemptId: "attempt",
      capacityId: "capacity",
      executionTargetId: "target",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 30_000),
    };
    let active = true;
    const store = {
      acquire: vi.fn<CapacityAdmissionStore["acquire"]>(async () => ({ state: "ADMITTED", lease })),
      heartbeat: vi.fn(async (_lease: CapacityLeaseHandle, _extensionMs: number) => {
        if (!active || lease.expiresAt.getTime() <= Date.now()) return false;
        lease.expiresAt = new Date(Date.now() + 30_000);
        return true;
      }),
      release: vi.fn(async () => {
        active = false;
        return true;
      }),
      terminalizeAttempt: vi.fn<CapacityAdmissionStore["terminalizeAttempt"]>(async () => ({
        state: "CANCELLED",
      })),
      reclaimExpired: vi.fn(async () => 0),
    };
    const runtime = new StoreCapacityAdmissionRuntime(store);
    const attempt = {
      requestId: "request",
      attemptId: "attempt",
      ownerId: "owner",
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: "test",
      deadlineAt: new Date(Date.now() + 900_000),
      candidates: [{ capacityId: "capacity", executionTargetId: "target", candidateOrder: 0 }],
    };
    const admit = async (signal?: AbortSignal) => {
      const result = await runtime.acquire(attempt, signal);
      if (result.state !== "ADMITTED") throw new Error("Expected admission");
      return result.lease;
    };
    return { lease, store, runtime, attempt, admit };
  }

  afterEach(() => vi.useRealTimers());

  it("has no owner or timer when closed without admissions", async () => {
    vi.useFakeTimers();
    const { runtime, attempt, store } = fixture();
    await runtime.close();
    expect(await runtime.acquire(attempt)).toEqual({ state: "CANCELLED" });
    expect(store.acquire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains capacity during a 31s dispatch and adopts the same heartbeat cadence", async () => {
    vi.useFakeTimers();
    const { runtime, store, lease, admit } = fixture();
    const handle = await admit();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(4);
    expect(lease.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(handle.signal?.aborted).toBe(false);
    const response = runtime.hold(new Response(new ReadableStream()), handle);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(5);
    await response.body!.cancel();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(5);
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts pending dispatch with a typed lease-loss reason when heartbeat returns false", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    const cancelled = vi.fn();
    const dispatch = new Promise<void>((_resolve, reject) => {
      handle.signal!.addEventListener("abort", () => {
        cancelled();
        reject(handle.signal!.reason);
      });
    });
    const outcome = expect(dispatch).rejects.toMatchObject({
      name: "CapacityLeaseLostError",
      kind: "ownership_lost",
    });
    store.heartbeat.mockResolvedValueOnce(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(isCapacityLeaseLost(handle.signal!.reason)).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(store.release).toHaveBeenCalledOnce();
    // Late headers cannot revive a lost owner or expose upstream bytes: the
    // hand-off is refused so the route classifies it as a precommit failure.
    const lateBody = new ReadableStream<Uint8Array>({ cancel: vi.fn() });
    expect(() => runtime.hold(new Response(lateBody), handle)).toThrow(CapacityLeaseLostError);
    await runtime.release(handle);
    await vi.advanceTimersByTimeAsync(31_000);
    // A false result is never retried.
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the dispatch alive across one transient heartbeat error (F2-CAP-5)", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    store.heartbeat.mockRejectedValueOnce(new Error("db unavailable"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    expect(handle.signal?.aborted).toBe(false);
    // Retried after the first backoff step and acknowledged.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(3);
    expect(handle.signal?.aborted).toBe(false);
    // The successful retry re-armed the watchdog from ITS query start, so
    // the dispatch outlives the TTL of the heartbeat before the error.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(handle.signal?.aborted).toBe(false);
    expect(store.release).not.toHaveBeenCalled();
    await runtime.release(handle);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases before the acknowledged TTL ends when heartbeat errors persist", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    // Admission confirmed ownership at t=0: the acknowledged TTL ends at 30 s.
    store.heartbeat.mockRejectedValue(new Error("db unavailable"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(17_500);
    // Retries at 11, 13, 17, 21, 25 s; the next 4 s step would not fit.
    expect(handle.signal?.aborted).toBe(true);
    expect(handle.signal?.reason).toMatchObject({ kind: "heartbeat_failed" });
    expect(store.heartbeat).toHaveBeenCalledTimes(7);
    expect(store.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(7);
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await runtime.close();
  });

  it("measures retry room from the LAST acknowledged renewal", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    // t=10 s renews successfully (acknowledged until 40 s); errors from t=20 s.
    await vi.advanceTimersByTimeAsync(10_000);
    store.heartbeat.mockRejectedValue(new Error("db unavailable"));
    await vi.advanceTimersByTimeAsync(20_500);
    // Past the TTL of the admission-time renewal, still inside the new one.
    expect(handle.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(handle.signal?.reason).toMatchObject({ kind: "heartbeat_failed" });
    expect(store.release).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it("stops a pending heartbeat retry backoff on shutdown", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    store.heartbeat.mockRejectedValueOnce(new Error("db unavailable"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handle.signal?.aborted).toBe(false);
    await runtime.close();
    expect(isCapacityLeaseLost(handle.signal?.reason)).toBe(false);
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("never lets an error extend the watchdog: a hung retry still ends at the TTL", async () => {
    vi.useFakeTimers();
    const { store, admit } = fixture();
    const handle = await admit();
    store.heartbeat
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(handle.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(handle.signal?.reason).toMatchObject({ kind: "heartbeat_timeout" });
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps an owner's lifetime as a backstop and stops every timer", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, admit } = fixture();
    const handle = await admit();
    await vi.advanceTimersByTimeAsync(CAPACITY_LEASE_MAX_LIFETIME_MS - 1);
    expect(handle.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.signal?.reason).toMatchObject({ kind: "max_lifetime" });
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    warn.mockRestore();
  });

  it("releases with a shutdown reason, not a lease loss, exactly once", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    await runtime.close();
    expect(handle.signal?.aborted).toBe(true);
    expect(isCapacityLeaseLost(handle.signal?.reason)).toBe(false);
    await runtime.close();
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts dispatch if a heartbeat stalls beyond the last acknowledged TTL", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const handle = await admit();
    let complete!: (retained: boolean) => void;
    store.heartbeat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(handle.signal?.aborted).toBe(true);
    expect(store.release).toHaveBeenCalledOnce();
    complete(true);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await runtime.close();
  });

  it("fails closed when initial ownership confirmation finds a stale lease", async () => {
    vi.useFakeTimers();
    const { runtime, store, attempt } = fixture();
    store.heartbeat.mockResolvedValueOnce(false);
    // A server-side lease loss names the lost member (callers exclude it and
    // fail over, or answer 503); it is never reported as a cancellation.
    expect(await runtime.acquire(attempt)).toMatchObject({
      state: "LEASE_LOST",
      executionTargetId: "target",
      reason: { kind: "ownership_lost" },
    });
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports persistent initial heartbeat errors as lease loss, not cancellation", async () => {
    vi.useFakeTimers();
    const { runtime, store, attempt } = fixture();
    store.heartbeat.mockRejectedValue(new Error("db unavailable"));
    const admission = runtime.acquire(attempt);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await admission).toMatchObject({
      state: "LEASE_LOST",
      reason: { kind: "heartbeat_failed" },
    });
    expect(store.release).toHaveBeenCalledOnce();
  });

  it("keeps a client abort during initial confirmation a cancellation", async () => {
    vi.useFakeTimers();
    const { runtime, store, attempt } = fixture();
    const controller = new AbortController();
    store.heartbeat.mockImplementationOnce(async () => {
      controller.abort(new Error("client gone"));
      return true;
    });
    expect(await runtime.acquire(attempt, controller.signal)).toEqual({ state: "CANCELLED" });
    expect(store.release).toHaveBeenCalledOnce();
  });

  it("deduplicates idempotent admission and overlapping heartbeat calls", async () => {
    vi.useFakeTimers();
    const { runtime, store, admit } = fixture();
    const first = await admit();
    const second = await admit();
    expect(second.signal).toBe(first.signal);
    let complete!: (retained: boolean) => void;
    store.heartbeat.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    const response = runtime.hold(new Response(new ReadableStream()), second);
    await runtime.release(first);
    complete(false);
    await response.body!.cancel().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["client abort", "dispatch failure", "shutdown", "EOF", "body error", "body cancel"])(
    "stops ownership on %s",
    async (exit) => {
      vi.useFakeTimers();
      const { runtime, store, admit } = fixture();
      const client = new AbortController();
      const handle = await admit(client.signal);
      await vi.advanceTimersByTimeAsync(10_000);
      if (exit === "client abort") client.abort();
      else if (exit === "shutdown") await runtime.close();
      else if (exit === "dispatch failure") await runtime.release(handle);
      else if (exit === "EOF")
        expect(await runtime.hold(new Response("done"), handle).text()).toBe("done");
      else if (exit === "body cancel")
        await runtime.hold(new Response(new ReadableStream()), handle).body!.cancel();
      else {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error("body failed"));
          },
        });
        await expect(runtime.hold(new Response(body), handle).text()).rejects.toThrow(
          "body failed",
        );
      }
      await vi.advanceTimersByTimeAsync(31_000);
      expect(handle.signal?.aborted).toBe(true);
      expect(store.heartbeat).toHaveBeenCalledTimes(2);
      expect(store.release).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels pending admission after its bounded polling delay on shutdown", async () => {
    vi.useFakeTimers();
    const { runtime, store, attempt } = fixture();
    store.acquire.mockResolvedValue({ state: "WAITING", requestId: "request" });
    const pending = runtime.acquire(attempt);
    await vi.advanceTimersByTimeAsync(1);
    const polls = store.acquire.mock.calls.length;
    await runtime.close();
    // The no-notification polling fallback has an existing bounded delay.
    await vi.advanceTimersByTimeAsync(100);
    expect(store.acquire).toHaveBeenCalledTimes(polls);
    expect(await pending).toEqual({ state: "CANCELLED" });
    expect(store.terminalizeAttempt).toHaveBeenCalledWith("attempt", "CANCELLED");
    expect(store.heartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an admission returned after shutdown without dispatching", async () => {
    vi.useFakeTimers();
    const { runtime, store, lease, attempt } = fixture();
    let complete!: () => void;
    store.acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ state: "ADMITTED", lease });
        }),
    );
    const pending = runtime.acquire(attempt);
    await vi.advanceTimersByTimeAsync(0);
    store.terminalizeAttempt.mockImplementationOnce(async () => ({
      state: "ADMITTED" as const,
      lease,
    }));
    await runtime.close();
    complete();
    expect(await pending).toEqual({ state: "CANCELLED" });
    expect(store.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the failed member and gives failover its own independent owner", async () => {
    vi.useFakeTimers();
    const { runtime, store, lease, admit } = fixture();
    const first = await admit();
    await runtime.release(first);
    store.acquire.mockResolvedValueOnce({
      state: "ADMITTED",
      lease: { ...lease, leaseId: "second", fencingToken: 2n },
    });
    store.heartbeat.mockClear().mockResolvedValue(true);
    const second = await admit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    expect(store.heartbeat).toHaveBeenCalledTimes(2);
    expect(store.heartbeat.mock.calls[0]?.[0]).toMatchObject({ leaseId: "second" });
    await runtime.release(second);
    expect(store.release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
