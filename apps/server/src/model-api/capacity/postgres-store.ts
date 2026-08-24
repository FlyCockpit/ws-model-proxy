import prisma, { Prisma } from "@ws-model-proxy/db";
import { SCHEDULER_VERSION, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type {
  AdmissionAttempt,
  AdmissionResult,
  CapacityAdmissionStore,
  CapacityLeaseHandle,
} from "./types.js";

type Db = typeof prisma;
const SERIALIZATION_CODES = new Set(["P2034", "40001", "40P01"]);

export function isRetryableCapacityTransactionError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return code !== undefined && SERIALIZATION_CODES.has(code);
}

export async function runCapacitySerializable<T>(
  db: Pick<Db, "$transaction">,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt >= 4 || !isRetryableCapacityTransactionError(error)) throw error;
      await pause(5 + Math.floor(Math.random() * 20));
    }
  }
}

export type CapacityNotifier = { notify(capacityIds: readonly string[]): Promise<void> };
export type CapacityWakeSource = {
  wait(capacityIds: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void>;
};

export async function waitWithCapacityPolling({
  capacityIds,
  deadlineAt,
  poll,
  wakeSource,
  signal,
  minimumPollMs = 40,
  maximumPollMs = 200,
}: {
  capacityIds: readonly string[];
  deadlineAt: Date;
  poll: () => Promise<AdmissionResult>;
  wakeSource?: CapacityWakeSource;
  signal?: AbortSignal;
  minimumPollMs?: number;
  maximumPollMs?: number;
}): Promise<AdmissionResult> {
  while (!signal?.aborted && Date.now() < deadlineAt.getTime()) {
    const result = await poll();
    if (result.state !== "WAITING") return result;
    const remaining = deadlineAt.getTime() - Date.now();
    const jitter = minimumPollMs + Math.floor(Math.random() * (maximumPollMs - minimumPollMs + 1));
    const timeout = Math.max(1, Math.min(remaining, jitter));
    if (wakeSource) await wakeSource.wait(capacityIds, timeout, signal);
    else await new Promise((resolve) => setTimeout(resolve, timeout));
  }
  return { state: signal?.aborted ? "CANCELLED" : "EXPIRED" };
}

export class PostgresCapacityAdmissionStore implements CapacityAdmissionStore {
  constructor(
    private readonly db: Db = prisma,
    private readonly serverInstance: string = crypto.randomUUID(),
    private readonly notifier?: CapacityNotifier,
  ) {}

  async acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult> {
    if (signal?.aborted) return { state: "CANCELLED" };
    const result = await this.#serializable(async (tx) => {
      const existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      if (existing?.Lease?.state === "ACTIVE")
        return {
          result: { state: "ADMITTED", lease: leaseHandle(existing.Lease) } as const,
          notify: [],
        };
      if (existing && existing.state !== "WAITING")
        return {
          result: { state: existing.state === "EXPIRED" ? "EXPIRED" : "CANCELLED" } as const,
          notify: [],
        };
      if (existing?.deadlineAt && existing.deadlineAt <= new Date()) {
        const expiredAt = new Date();
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { state: "EXPIRED", terminalAt: expiredAt, terminalReason: "deadline" },
        });
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: existing.id, state: "WAITING" },
          data: { state: "EXPIRED", stateChangedAt: expiredAt, terminalReason: "deadline" },
        });
        return { result: { state: "EXPIRED" } as const, notify: [] };
      }

      const capacityIds = [
        ...new Set(
          existing
            ? existing.Waiters.map((waiter) => waiter.capacityId)
            : attempt.candidates.map((candidate) => candidate.capacityId),
        ),
      ].sort();
      for (const capacityId of capacityIds)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityId}, 0))`;
      const now = new Date();
      const request =
        existing ??
        (await tx.admissionRequest.create({
          data: {
            userId: attempt.ownerId,
            requestId: attempt.requestId,
            attemptId: attempt.attemptId,
            sourceKind: attempt.sourceKind,
            poolId: attempt.poolId,
            directExecutionTargetId:
              attempt.sourceKind === "DIRECT"
                ? attempt.candidates[0]?.executionTargetId
                : undefined,
            basePriority: attempt.basePriority,
            enqueueSequence:
              BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)),
            deadlineAt: attempt.deadlineAt,
            connectionOwner: attempt.connectionOwner,
            heartbeatAt: now,
            Waiters: {
              create: attempt.candidates.map((candidate) => ({
                userId: attempt.ownerId,
                capacityId: candidate.capacityId,
                executionTargetId: candidate.executionTargetId,
                poolId: attempt.poolId,
                poolMemberId: candidate.poolMemberId,
                candidateOrder: candidate.candidateOrder,
              })),
            },
          },
        }));

      for (const capacityId of capacityIds) await this.#admitOne(tx, capacityId, now);
      const refreshed = await tx.admissionRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { Lease: true },
      });
      return {
        result:
          refreshed.Lease?.state === "ACTIVE"
            ? ({ state: "ADMITTED", lease: leaseHandle(refreshed.Lease) } as const)
            : ({ state: "WAITING", requestId: refreshed.id } as const),
        notify: capacityIds,
      };
    });
    if (result.notify.length) await this.notifier?.notify(result.notify);
    return result.result;
  }

  async #admitOne(tx: Prisma.TransactionClient, capacityId: string, now: Date) {
    const capacity = await tx.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } });
    const active = await tx.capacityLease.count({ where: { capacityId, state: "ACTIVE" } });
    if (capacity.hardConcurrencyLimit !== null && active >= capacity.hardConcurrencyLimit) return;
    const waiters = await tx.capacityWaiter.findMany({
      where: {
        capacityId,
        state: "WAITING",
        AdmissionRequest: {
          state: "WAITING",
          OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
        },
      },
      include: { AdmissionRequest: true, PoolMember: true },
    });
    const memberPolicies = await tx.poolMember.findMany({
      where: { ExecutionTarget: { capacityId } },
      select: {
        id: true,
        capacityPriority: true,
        capacityReservedSlots: true,
        capacityBorrowPolicy: true,
      },
    });
    const eligibility = new Map<string, { borrowed: boolean }>();
    const eligible = [];
    for (const waiter of waiters) {
      const memberLimit = waiter.PoolMember?.capacityConcurrencyLimit;
      if (memberLimit !== null && memberLimit !== undefined && waiter.poolMemberId) {
        const memberActive = await tx.capacityLease.count({
          where: { poolMemberId: waiter.poolMemberId, state: "ACTIVE" },
        });
        if (memberActive >= memberLimit) continue;
      }
      const higherPolicies = memberPolicies.filter(
        (policy) => policy.capacityPriority > waiter.AdmissionRequest.basePriority,
      );
      const reservedForHigherPriority = higherPolicies.reduce(
        (total, policy) => total + policy.capacityReservedSlots,
        0,
      );
      const higherPriorityQueued = waiters.some(
        (entry) => entry.AdmissionRequest.basePriority > waiter.AdmissionRequest.basePriority,
      );
      if (
        capacity.hardConcurrencyLimit !== null &&
        reservedForHigherPriority > 0 &&
        higherPriorityQueued &&
        active >= capacity.hardConcurrencyLimit - reservedForHigherPriority
      )
        continue;
      const reservedForOthers = memberPolicies
        .filter((policy) => policy.id !== waiter.poolMemberId)
        .reduce((total, policy) => total + policy.capacityReservedSlots, 0);
      const borrowed =
        capacity.hardConcurrencyLimit !== null &&
        reservedForOthers > 0 &&
        active >= capacity.hardConcurrencyLimit - reservedForOthers;
      if (borrowed && waiter.PoolMember?.capacityBorrowPolicy === "NEVER") continue;
      eligible.push({
        admissionRequestId: waiter.admissionRequestId,
        priority: waiter.AdmissionRequest.basePriority,
        enqueueSequence: waiter.AdmissionRequest.enqueueSequence,
        eligible: true,
      });
      eligibility.set(waiter.admissionRequestId, { borrowed });
    }
    if (!eligible.length) return;
    const deficits = schedulerDeficits(capacity.schedulerDeficits);
    const decision = scheduleWeightedDeficitRoundRobin({
      candidates: eligible,
      state: { cursor: capacity.schedulerCursor, deficits, version: capacity.schedulerVersion },
    });
    if (!decision.winner) return;
    const waiter = waiters.find(
      (entry) => entry.admissionRequestId === decision.winner?.admissionRequestId,
    );
    if (!waiter) return;
    const updatedCapacity = await tx.inferenceCapacity.update({
      where: { id: capacityId },
      data: {
        schedulerCursor: decision.state.cursor,
        schedulerDeficits: decision.state.deficits,
        schedulerVersion: SCHEDULER_VERSION,
        nextFencingToken: { increment: 1 },
      },
    });
    const fencingToken = updatedCapacity.nextFencingToken - 1n;
    await tx.capacityLease.create({
      data: {
        userId: waiter.userId,
        requestId: waiter.AdmissionRequest.requestId,
        attemptId: waiter.AdmissionRequest.attemptId,
        admissionRequestId: waiter.admissionRequestId,
        capacityId,
        executionTargetId: waiter.executionTargetId,
        poolId: waiter.poolId,
        poolMemberId: waiter.poolMemberId,
        priority: waiter.AdmissionRequest.basePriority,
        reservationClass: waiter.AdmissionRequest.basePriority,
        borrowed: eligibility.get(waiter.admissionRequestId)?.borrowed ?? false,
        fencingToken,
        ownerServerInstance: this.serverInstance,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + 30_000),
      },
    });
    await tx.admissionRequest.update({
      where: { id: waiter.admissionRequestId },
      data: { state: "ADMITTED" },
    });
    await tx.capacityWaiter.updateMany({
      where: { admissionRequestId: waiter.admissionRequestId },
      data: { state: "CANCELLED", stateChangedAt: now, terminalReason: "sibling_lost" },
    });
    await tx.capacityWaiter.update({
      where: { id: waiter.id },
      data: { state: "ADMITTED", stateChangedAt: now, terminalReason: null },
    });
  }

  async heartbeat(lease: CapacityLeaseHandle, expiresAt: Date): Promise<boolean> {
    const result = await this.db.capacityLease.updateMany({
      where: { id: lease.leaseId, fencingToken: lease.fencingToken, state: "ACTIVE" },
      data: { heartbeatAt: new Date(), expiresAt },
    });
    return result.count === 1;
  }

  async release(lease: CapacityLeaseHandle): Promise<boolean> {
    const now = new Date();
    const released = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lease.capacityId}, 0))`;
      const result = await tx.capacityLease.updateMany({
        where: { id: lease.leaseId, fencingToken: lease.fencingToken, state: "ACTIVE" },
        data: { state: "RELEASED", releasedAt: now, releaseReason: "released" },
      });
      if (result.count)
        await tx.admissionRequest.updateMany({
          where: { attemptId: lease.attemptId, state: "ADMITTED" },
          data: { state: "TERMINAL", terminalAt: now },
        });
      return result.count === 1;
    });
    if (released) await this.notifier?.notify([lease.capacityId]);
    return released;
  }

  async cancelAttempt(attemptId: string): Promise<boolean> {
    const now = new Date();
    const result = await this.db.admissionRequest.updateMany({
      where: { attemptId, state: "WAITING" },
      data: { state: "CANCELLED", terminalAt: now, terminalReason: "cancelled" },
    });
    if (result.count)
      await this.db.capacityWaiter.updateMany({
        where: { AdmissionRequest: { attemptId }, state: "WAITING" },
        data: { state: "CANCELLED", stateChangedAt: now, terminalReason: "cancelled" },
      });
    return result.count === 1;
  }

  async reclaimExpired(now: Date, limit: number): Promise<number> {
    const expired = await this.db.capacityLease.findMany({
      where: { state: "ACTIVE", expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    let reclaimed = 0;
    for (const lease of expired) {
      const result = await this.db.capacityLease.updateMany({
        where: { id: lease.id, fencingToken: lease.fencingToken, state: "ACTIVE" },
        data: { state: "RECLAIMED", releasedAt: now, releaseReason: "expired" },
      });
      reclaimed += result.count;
    }
    return reclaimed;
  }

  async sweepAbandoned({
    now,
    heartbeatBefore,
    limit,
  }: {
    now: Date;
    heartbeatBefore: Date;
    limit: number;
  }) {
    const requests = await this.db.admissionRequest.findMany({
      where: {
        state: "WAITING",
        OR: [{ deadlineAt: { lte: now } }, { heartbeatAt: { lt: heartbeatBefore } }],
      },
      orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    for (const request of requests) {
      const expired = request.deadlineAt !== null && request.deadlineAt <= now;
      await this.db.$transaction([
        this.db.admissionRequest.updateMany({
          where: { id: request.id, state: "WAITING" },
          data: {
            state: expired ? "EXPIRED" : "CANCELLED",
            terminalAt: now,
            terminalReason: expired ? "deadline" : "connection_abandoned",
          },
        }),
        this.db.capacityWaiter.updateMany({
          where: { admissionRequestId: request.id, state: "WAITING" },
          data: {
            state: expired ? "EXPIRED" : "CANCELLED",
            stateChangedAt: now,
            terminalReason: expired ? "deadline" : "connection_abandoned",
          },
        }),
      ]);
    }
    return { requests: requests.length, leases: await this.reclaimExpired(now, limit) };
  }

  async #serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runCapacitySerializable(this.db, work);
  }
}

function schedulerDeficits(value: Prisma.JsonValue): number[] {
  if (Array.isArray(value) && value.length === 32)
    return value.map((entry) => (typeof entry === "number" && entry >= 0 ? entry : 0));
  return Array(32).fill(0);
}

function leaseHandle(lease: {
  id: string;
  attemptId: string;
  capacityId: string;
  executionTargetId: string;
  poolMemberId: string | null;
  fencingToken: bigint;
  expiresAt: Date;
}): CapacityLeaseHandle {
  return {
    leaseId: lease.id,
    attemptId: lease.attemptId,
    capacityId: lease.capacityId,
    executionTargetId: lease.executionTargetId,
    ...(lease.poolMemberId ? { poolMemberId: lease.poolMemberId } : {}),
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
  };
}
