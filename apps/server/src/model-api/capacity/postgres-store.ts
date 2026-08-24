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
      const observedRows = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT CURRENT_TIMESTAMP AS now`;
      const observedAt = observedRows[0]?.now;
      if (!observedAt) throw new Error("Database clock unavailable.");
      if (existing?.Lease?.state === "ACTIVE" && existing.Lease.expiresAt <= observedAt) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${existing.Lease.capacityId}, 0))`;
        const currentLease = await tx.capacityLease.findUniqueOrThrow({
          where: { id: existing.Lease.id },
        });
        const lockedRows = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`;
        const lockedNow = lockedRows[0]?.now;
        if (!lockedNow) throw new Error("Database clock unavailable.");
        if (currentLease.state === "ACTIVE" && currentLease.expiresAt > lockedNow)
          return {
            result: { state: "ADMITTED", lease: leaseHandle(currentLease) } as const,
            notify: [],
          };
        await tx.capacityLease.updateMany({
          where: {
            id: existing.Lease.id,
            fencingToken: existing.Lease.fencingToken,
            state: "ACTIVE",
          },
          data: { state: "RECLAIMED", releasedAt: lockedNow, releaseReason: "expired" },
        });
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { state: "TERMINAL", terminalAt: lockedNow, terminalReason: "lease_expired" },
        });
        return { result: { state: "EXPIRED" } as const, notify: [existing.Lease.capacityId] };
      }
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
      if (existing)
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { heartbeatAt: now, connectionOwner: attempt.connectionOwner },
        });
      const sequence = existing
        ? []
        : await tx.$queryRaw<
            Array<{ value: bigint }>
          >`SELECT nextval('admission_enqueue_sequence') AS value`;
      const enqueueSequence = existing?.enqueueSequence ?? sequence[0]?.value;
      if (enqueueSequence === undefined) throw new Error("Admission enqueue sequence unavailable.");
      const resolvedCandidates = existing ? [] : await this.#resolveCandidates(tx, attempt);
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
            enqueueSequence,
            deadlineAt: attempt.deadlineAt,
            connectionOwner: attempt.connectionOwner,
            heartbeatAt: now,
            Waiters: {
              create: resolvedCandidates.map((candidate) => ({
                userId: attempt.ownerId,
                requestId: attempt.requestId,
                attemptId: attempt.attemptId,
                enqueueSequence,
                capacityId: candidate.capacityId,
                executionTargetId: candidate.executionTargetId,
                poolId: attempt.poolId,
                poolMemberId: candidate.poolMemberId,
                candidateOrder: candidate.candidateOrder,
                effectivePriority: candidate.priority,
                effectiveConcurrencyLimit: candidate.memberConcurrencyCeiling,
                effectiveConcurrencyScope: candidate.concurrencyScope,
                effectiveConcurrencyScopeId: candidate.concurrencyScopeId,
                effectiveReservedSlots: candidate.reservedSlots,
                effectiveBorrowPolicy: candidate.allowBorrowReserved ? "WHEN_IDLE" : "NEVER",
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

  async #resolveCandidates(tx: Prisma.TransactionClient, attempt: AdmissionAttempt) {
    if (!attempt.candidates.length) throw new Error("Admission requires at least one candidate.");
    const orders = new Set<number>();
    const targets = new Set<string>();
    return Promise.all(
      attempt.candidates.map(async (candidate) => {
        if (!Number.isInteger(candidate.candidateOrder) || candidate.candidateOrder < 0)
          throw new Error("Admission candidate order must be a nonnegative integer.");
        if (orders.has(candidate.candidateOrder) || targets.has(candidate.executionTargetId))
          throw new Error("Admission candidates must have unique order and execution targets.");
        orders.add(candidate.candidateOrder);
        targets.add(candidate.executionTargetId);
        const target = await tx.executionTarget.findFirst({
          where: {
            id: candidate.executionTargetId,
            userId: attempt.ownerId,
            inferenceCapacityId: candidate.capacityId,
          },
        });
        if (!target)
          throw new Error(
            "Admission candidate does not belong to the requested owner and capacity.",
          );
        if (attempt.sourceKind === "DIRECT") {
          if (attempt.poolId || candidate.poolMemberId || attempt.candidates.length !== 1)
            throw new Error("Direct admission requires exactly one direct execution target.");
          return {
            ...candidate,
            priority: target.directPriority,
            memberConcurrencyCeiling: target.directConcurrencyLimit ?? undefined,
            concurrencyScope: "DIRECT_TARGET",
            concurrencyScopeId: target.id,
            reservedSlots: target.directReservedSlots,
            allowBorrowReserved: target.directBorrowPolicy === "WHEN_IDLE",
          };
        }
        if (!attempt.poolId || !candidate.poolMemberId)
          throw new Error("Pool admission requires a pool and member for every candidate.");
        const member = await tx.poolMember.findFirst({
          where: {
            id: candidate.poolMemberId,
            poolId: attempt.poolId,
            executionTargetId: candidate.executionTargetId,
            ModelPool: { userId: attempt.ownerId },
          },
          include: { ModelPool: true },
        });
        if (!member)
          throw new Error("Admission pool candidate is not an owned member of the requested pool.");
        // Member settings are the most-specific policy. Nullable limits inherit
        // the pool limit; scalar member values intentionally override pool defaults.
        return {
          ...candidate,
          priority: member.capacityPriority ?? member.ModelPool.capacityPriority,
          memberConcurrencyCeiling:
            member.capacityConcurrencyLimit ??
            member.ModelPool.capacityConcurrencyLimit ??
            undefined,
          concurrencyScope: member.capacityConcurrencyLimit !== null ? "MEMBER" : "POOL",
          concurrencyScopeId:
            member.capacityConcurrencyLimit !== null ? member.id : member.ModelPool.id,
          reservedSlots: member.capacityReservedSlots ?? member.ModelPool.capacityReservedSlots,
          allowBorrowReserved:
            (member.capacityBorrowPolicy ?? member.ModelPool.capacityBorrowPolicy) === "WHEN_IDLE",
        };
      }),
    );
  }

  async #admitOne(tx: Prisma.TransactionClient, capacityId: string, now: Date): Promise<boolean> {
    const capacity = await tx.inferenceCapacity.findUniqueOrThrow({ where: { id: capacityId } });
    const activeLeases = await tx.capacityLease.findMany({
      where: { capacityId, state: "ACTIVE" },
      select: { executionTargetId: true, poolMemberId: true },
    });
    const active = activeLeases.length;
    if (capacity.hardConcurrencyLimit !== null && active >= capacity.hardConcurrencyLimit)
      return false;
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
    const configuredReservationMembers = await tx.poolMember.findMany({
      where: { ExecutionTarget: { capacityId } },
      include: { ModelPool: true },
    });
    const configuredReservations: Array<{ ownerKey: string; capacityReservedSlots: number }> = [];
    const configuredDirectReservations = await tx.executionTarget.findMany({
      where: { inferenceCapacityId: capacityId, directReservedSlots: { gt: 0 } },
      select: { id: true, directReservedSlots: true },
    });
    for (const target of configuredDirectReservations)
      configuredReservations.push({
        ownerKey: `direct:${target.id}`,
        capacityReservedSlots: target.directReservedSlots,
      });
    for (const member of configuredReservationMembers) {
      const slots = member.capacityReservedSlots ?? member.ModelPool.capacityReservedSlots;
      if (slots > 0)
        configuredReservations.push({
          ownerKey: `member:${member.id}`,
          capacityReservedSlots: slots,
        });
    }
    const reservationsByOwner = allocateReservationSlots(
      configuredReservations,
      capacity.hardConcurrencyLimit,
    );
    const activeByOwner = new Map<string, number>();
    for (const lease of activeLeases) {
      const ownerKey = lease.poolMemberId
        ? `member:${lease.poolMemberId}`
        : `direct:${lease.executionTargetId}`;
      activeByOwner.set(ownerKey, (activeByOwner.get(ownerKey) ?? 0) + 1);
    }
    const eligibility = new Map<string, { borrowed: boolean }>();
    const eligible = [];
    for (const waiter of waiters) {
      const memberLimit = waiter.effectiveConcurrencyLimit;
      if (memberLimit !== null && memberLimit !== undefined) {
        const memberActive = await tx.capacityLease.count({
          where: {
            state: "ACTIVE",
            ...(waiter.effectiveConcurrencyScope === "POOL"
              ? { poolId: waiter.effectiveConcurrencyScopeId }
              : waiter.effectiveConcurrencyScope === "MEMBER"
                ? { poolMemberId: waiter.effectiveConcurrencyScopeId }
                : { executionTargetId: waiter.effectiveConcurrencyScopeId }),
          },
        });
        if (memberActive >= memberLimit) continue;
      }
      const ownerKey = waiter.poolMemberId
        ? `member:${waiter.poolMemberId}`
        : `direct:${waiter.executionTargetId}`;
      const reservedForOthers = Math.min(
        capacity.hardConcurrencyLimit ?? Number.MAX_SAFE_INTEGER,
        [...reservationsByOwner.entries()]
          .filter(([reservationOwner]) => reservationOwner !== ownerKey)
          .reduce(
            (total, [reservationOwner, slots]) =>
              total + Math.max(0, slots - (activeByOwner.get(reservationOwner) ?? 0)),
            0,
          ),
      );
      const ownReservedRemaining = Math.max(
        0,
        (reservationsByOwner.get(ownerKey) ?? 0) - (activeByOwner.get(ownerKey) ?? 0),
      );
      const borrowed =
        capacity.hardConcurrencyLimit !== null &&
        ownReservedRemaining === 0 &&
        reservedForOthers > 0 &&
        capacity.hardConcurrencyLimit - active <= reservedForOthers;
      const queuedReservationOwnerNeedsSlot = waiters.some((entry) => {
        const queuedOwner = entry.poolMemberId
          ? `member:${entry.poolMemberId}`
          : `direct:${entry.executionTargetId}`;
        return (
          entry.id !== waiter.id &&
          queuedOwner !== ownerKey &&
          (reservationsByOwner.get(queuedOwner) ?? 0) > (activeByOwner.get(queuedOwner) ?? 0)
        );
      });
      if (borrowed && queuedReservationOwnerNeedsSlot) continue;
      if (borrowed && waiter.effectiveBorrowPolicy === "NEVER") continue;
      eligible.push({
        admissionRequestId: waiter.admissionRequestId,
        waiterId: waiter.id,
        candidateOrder: waiter.candidateOrder,
        priority: waiter.effectivePriority,
        enqueueSequence: waiter.AdmissionRequest.enqueueSequence,
        eligible: true,
      });
      eligibility.set(waiter.id, { borrowed });
    }
    if (!eligible.length) return false;
    const deficits = schedulerDeficits(capacity.schedulerDeficits);
    const decision = scheduleWeightedDeficitRoundRobin({
      candidates: eligible,
      state: { cursor: capacity.schedulerCursor, deficits, version: capacity.schedulerVersion },
    });
    if (!decision.winner) return false;
    const waiter = waiters.find((entry) => entry.id === decision.winner?.waiterId);
    if (!waiter) return false;
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
        priority: waiter.effectivePriority,
        reservationClass: waiter.effectivePriority,
        borrowed: eligibility.get(waiter.id)?.borrowed ?? false,
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
    return true;
  }

  async #fillAvailable(tx: Prisma.TransactionClient, capacityId: string, now: Date) {
    while (await this.#admitOne(tx, capacityId, now)) {
      // Each iteration consumes one durable waiter and rechecks physical/member
      // limits, so this terminates without relying on a caller-provided bound.
    }
  }

  async heartbeat(lease: CapacityLeaseHandle, expiresAt: Date): Promise<boolean> {
    return this.#serializable(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lease.capacityId}, 0))`;
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const now = clockRows[0]?.now;
      if (!now) throw new Error("Database clock unavailable.");
      const result = await tx.capacityLease.updateMany({
        where: {
          id: lease.leaseId,
          fencingToken: lease.fencingToken,
          state: "ACTIVE",
          expiresAt: { gt: now },
        },
        data: { heartbeatAt: now, expiresAt },
      });
      return result.count === 1;
    });
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
      if (result.count) await this.#fillAvailable(tx, lease.capacityId, now);
      return result.count === 1;
    });
    if (released) await this.notifier?.notify([lease.capacityId]);
    return released;
  }

  async cancelAttempt(attemptId: string): Promise<boolean> {
    const now = new Date();
    const cancelled = await this.#serializable(async (tx) => {
      const request = await tx.admissionRequest.findUnique({
        where: { attemptId },
        include: { Waiters: true },
      });
      if (request?.state !== "WAITING") return { count: 0, capacities: [] as string[] };
      const capacities = [...new Set(request.Waiters.map((waiter) => waiter.capacityId))].sort();
      for (const capacityId of capacities)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityId}, 0))`;
      const result = await tx.admissionRequest.updateMany({
        where: { id: request.id, state: "WAITING" },
        data: { state: "CANCELLED", terminalAt: now, terminalReason: "cancelled" },
      });
      if (result.count)
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: request.id, state: "WAITING" },
          data: { state: "CANCELLED", stateChangedAt: now, terminalReason: "cancelled" },
        });
      return { count: result.count, capacities };
    });
    if (cancelled.count) await this.notifier?.notify(cancelled.capacities);
    const result = cancelled;
    return result.count === 1;
  }

  async reclaimExpired(_now: Date, limit: number): Promise<number> {
    const clockRows = await this.db.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const databaseNow = clockRows[0]?.now;
    if (!databaseNow) throw new Error("Database clock unavailable.");
    const expired = await this.db.capacityLease.findMany({
      where: { state: "ACTIVE", expiresAt: { lte: databaseNow } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    let reclaimed = 0;
    for (const lease of expired) {
      const result = await this.#serializable(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lease.capacityId}, 0))`;
        const lockedRows = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`;
        const lockedNow = lockedRows[0]?.now;
        if (!lockedNow) throw new Error("Database clock unavailable.");
        const update = await tx.capacityLease.updateMany({
          where: {
            id: lease.id,
            fencingToken: lease.fencingToken,
            state: "ACTIVE",
            expiresAt: { lte: lockedNow },
          },
          data: { state: "RECLAIMED", releasedAt: lockedNow, releaseReason: "expired" },
        });
        if (update.count) {
          await tx.admissionRequest.updateMany({
            where: { id: lease.admissionRequestId, state: "ADMITTED" },
            data: { state: "TERMINAL", terminalAt: lockedNow, terminalReason: "lease_expired" },
          });
          await this.#fillAvailable(tx, lease.capacityId, lockedNow);
        }
        return update;
      });
      reclaimed += result.count;
      if (result.count) await this.notifier?.notify([lease.capacityId]);
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
    const graceMs = Math.max(0, now.getTime() - heartbeatBefore.getTime());
    const clockRows = await this.db.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    const databaseNow = clockRows[0]?.now;
    if (!databaseNow) throw new Error("Database clock unavailable.");
    const databaseHeartbeatBefore = new Date(databaseNow.getTime() - graceMs);
    const requests = await this.db.admissionRequest.findMany({
      where: {
        state: "WAITING",
        OR: [
          { deadlineAt: { lte: databaseNow } },
          { heartbeatAt: { lt: databaseHeartbeatBefore } },
        ],
      },
      orderBy: [{ heartbeatAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    let sweptRequests = 0;
    for (const request of requests) {
      const swept = await this.#serializable(async (tx) => {
        const current = await tx.admissionRequest.findUnique({
          where: { id: request.id },
          include: { Waiters: true },
        });
        if (current?.state !== "WAITING") return [] as string[];
        const capacities = [...new Set(current.Waiters.map((waiter) => waiter.capacityId))].sort();
        for (const capacityId of capacities)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityId}, 0))`;
        const lockedRows = await tx.$queryRaw<
          Array<{ now: Date }>
        >`SELECT clock_timestamp() AS now`;
        const lockedNow = lockedRows[0]?.now;
        if (!lockedNow) throw new Error("Database clock unavailable.");
        const lockedHeartbeatBefore = new Date(lockedNow.getTime() - graceMs);
        if (
          (current.deadlineAt === null || current.deadlineAt > lockedNow) &&
          current.heartbeatAt >= lockedHeartbeatBefore
        )
          return [] as string[];
        const expired = current.deadlineAt !== null && current.deadlineAt <= lockedNow;
        const updated = await tx.admissionRequest.updateMany({
          where: {
            id: current.id,
            state: "WAITING",
            ...(expired
              ? { deadlineAt: { lte: lockedNow } }
              : { heartbeatAt: { lt: lockedHeartbeatBefore } }),
          },
          data: {
            state: expired ? "EXPIRED" : "CANCELLED",
            terminalAt: lockedNow,
            terminalReason: expired ? "deadline" : "connection_abandoned",
          },
        });
        if (!updated.count) return [] as string[];
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: current.id, state: "WAITING" },
          data: {
            state: expired ? "EXPIRED" : "CANCELLED",
            stateChangedAt: lockedNow,
            terminalReason: expired ? "deadline" : "connection_abandoned",
          },
        });
        return capacities;
      });
      if (swept.length) {
        sweptRequests++;
        await this.notifier?.notify(swept);
      }
    }
    return { requests: sweptRequests, leases: await this.reclaimExpired(now, limit) };
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

export function allocateReservationSlots(
  reservations: readonly { ownerKey: string; capacityReservedSlots: number }[],
  physicalLimit: number | null,
): Map<string, number> {
  const combined = new Map<string, number>();
  for (const reservation of reservations)
    combined.set(
      reservation.ownerKey,
      (combined.get(reservation.ownerKey) ?? 0) + reservation.capacityReservedSlots,
    );
  const total = [...combined.values()].reduce((sum, slots) => sum + slots, 0);
  if (physicalLimit === null || total <= physicalLimit) return combined;
  const shares = [...combined.entries()].map(([ownerKey, slots]) => {
    const exact = (slots * physicalLimit) / total;
    return { ownerKey, slots: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let unassigned = physicalLimit - shares.reduce((sum, share) => sum + share.slots, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.ownerKey.localeCompare(b.ownerKey));
  for (const share of shares) {
    if (unassigned <= 0) break;
    share.slots++;
    unassigned--;
  }
  return new Map(shares.map(({ ownerKey, slots }) => [ownerKey, slots]));
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
