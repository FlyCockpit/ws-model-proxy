import prisma, { Prisma } from "@ws-model-proxy/db";
import { SCHEDULER_VERSION, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type {
  AdmissionAttempt,
  AdmissionResult,
  AdmissionTerminalizationResult,
  CapacityAdmissionStore,
  CapacityLeaseHandle,
} from "./types.js";

type Db = typeof prisma;
const SERIALIZATION_CODES = new Set(["P2034", "40001", "40P01"]);

export function isRetryableCapacityTransactionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of ["code", "originalCode"]) {
      const code = record[key];
      if (typeof code === "string" && SERIALIZATION_CODES.has(code)) return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"]) pending.push(record[key]);
  }
  return false;
}

export async function runCapacitySerializable<T>(
  db: Pick<Db, "$transaction">,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const retryDeadline = Date.now() + 15_000;
  for (let attempt = 0; ; attempt++) {
    try {
      // Capacity mutations are serialized by transaction-scoped advisory
      // locks. READ COMMITTED is intentional: a SERIALIZABLE transaction
      // fixes its snapshot before a contended advisory-lock call returns, so
      // every predecessor in a lock queue can force another 40001 retry. With
      // READ COMMITTED, the statement after the lock observes the predecessor's
      // commit while the advisory lock still prevents oversubscription.
      return await db.$transaction(work, {
        isolationLevel: "ReadCommitted",
        timeout: Math.max(1, retryDeadline - Date.now()),
      });
    } catch (error) {
      if (
        attempt >= 4 ||
        Date.now() >= retryDeadline ||
        !isRetryableCapacityTransactionError(error)
      )
        throw error;
      // Full jitter with an exponential cap keeps the total retry sleep below
      // 80 ms (7 + 15 + 23 + 31) instead of allowing an unbounded retry storm.
      const capMs = Math.min(31, 7 + attempt * 8);
      await pause(
        Math.max(0, Math.min(retryDeadline - Date.now(), Math.floor(Math.random() * (capMs + 1)))),
      );
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

  async #notifyBestEffort(capacityIds: readonly string[]): Promise<void> {
    if (!this.notifier || capacityIds.length === 0) return;
    try {
      await this.notifier.notify(capacityIds);
    } catch (error) {
      // Notifications are only latency hints. The durable transaction has
      // already committed, so notifier failure must never change its outcome.
      console.warn("[capacity] wake notification failed", {
        errorClass: error instanceof Error ? error.name : "UnknownError",
        capacityCount: capacityIds.length,
      });
    }
  }

  async acquire(attempt: AdmissionAttempt, signal?: AbortSignal): Promise<AdmissionResult> {
    if (signal?.aborted) return { state: "CANCELLED" };
    const result = await this.#serializable(async (tx) => {
      // Identical attempts must share one creation boundary even if a buggy
      // caller supplies a different candidate list on retry. This lock is
      // always acquired before capacity locks, giving every acquire operation
      // one deterministic global order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admission-attempt:${attempt.attemptId}`}, 0))`;
      let existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      // Policy writers take the execution-target row and its capacity-policy
      // advisory fence before changing pool/member/direct limits. Admission
      // must join that same lock domain before it resolves and persists the
      // effective policy; otherwise an unlimited admission on capacity A can
      // race a pool-wide unlimited -> limited update while another admission
      // enters through capacity B.
      const policyTargetIds = existing
        ? existing.Waiters.map((waiter) => waiter.executionTargetId)
        : attempt.candidates.map((candidate) => candidate.executionTargetId);
      await this.#lockExecutionTargetPolicies(tx, policyTargetIds);
      // READ COMMITTED gives this statement the committed policy snapshot of
      // the predecessor that released a contended fence.
      existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      const resolvedCandidates = existing ? [] : await this.#resolveCandidates(tx, attempt);
      const orderedCapacityIds = [
        ...new Set(
          (existing
            ? existing.Waiters.filter((waiter) => waiter.state === "WAITING").sort(
                (left, right) => left.candidateOrder - right.candidateOrder,
              )
            : [...attempt.candidates].sort(
                (left, right) => left.candidateOrder - right.candidateOrder,
              )
          ).map((candidate) => candidate.capacityId),
        ),
      ];
      if (
        existing?.Lease?.state === "ACTIVE" &&
        !orderedCapacityIds.includes(existing.Lease.capacityId)
      )
        orderedCapacityIds.push(existing.Lease.capacityId);
      const candidateScopeKeys = existing
        ? existing.Waiters.flatMap((candidate) =>
            candidate.effectiveConcurrencyLimit === null
              ? []
              : [
                  concurrencyLockKey(
                    candidate.effectiveConcurrencyScope,
                    candidate.effectiveConcurrencyScopeId,
                  ),
                ],
          )
        : resolvedCandidates.flatMap((candidate) =>
            candidate.memberConcurrencyCeiling === undefined
              ? []
              : [concurrencyLockKey(candidate.concurrencyScope, candidate.concurrencyScopeId)],
          );
      // Every shared scope lock sorts before every physical-capacity lock.
      // Release/reclaim use the same order, preventing both cross-capacity
      // write skew and advisory-lock inversion.
      const capacityIds = [...orderedCapacityIds].sort();
      await this.#lockAdmissionResources(tx, capacityIds, candidateScopeKeys);
      // The initial graph read only discovers locks for an idempotent retry.
      // Re-read after all locks so every decision uses a fresh committed view.
      existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      if (existing) {
        await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${existing.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM capacity_waiter WHERE "admissionRequestId" = ${existing.id} FOR UPDATE`;
      }
      const observedRows = await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      const observedAt = observedRows[0]?.now;
      if (!observedAt) throw new Error("Database clock unavailable.");
      if (existing?.deadlineAt === null) {
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { deadlineAt: attempt.deadlineAt },
        });
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: existing.id, deadlineAt: null },
          data: { deadlineAt: attempt.deadlineAt },
        });
        // The request was read before the capacity locks. Keep the local view
        // aligned with the durable compatibility repair for checks below.
        existing.deadlineAt = attempt.deadlineAt;
      }
      if (existing?.Lease?.state === "ACTIVE" && existing.Lease.expiresAt <= observedAt) {
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
        if (existing.relayRequestId)
          await tx.relayRequest.updateMany({
            where: { id: existing.relayRequestId, admissionAttemptId: attempt.attemptId },
            data: { admissionTerminalState: "TERMINAL" },
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
      if (existing?.deadlineAt && existing.deadlineAt <= observedAt) {
        const expiredAt = observedAt;
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { state: "EXPIRED", terminalAt: expiredAt, terminalReason: "deadline" },
        });
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: existing.id, state: "WAITING" },
          data: { state: "EXPIRED", stateChangedAt: expiredAt, terminalReason: "deadline" },
        });
        if (existing.relayRequestId)
          await tx.relayRequest.updateMany({
            where: { id: existing.relayRequestId, admissionAttemptId: attempt.attemptId },
            data: { admissionTerminalState: "EXPIRED" },
          });
        return { result: { state: "EXPIRED" } as const, notify: [] };
      }

      if (existing) {
        await tx.capacityWaiter.updateMany({
          where: {
            admissionRequestId: existing.id,
            state: "WAITING",
            deadlineAt: { lte: observedAt },
          },
          data: {
            state: "EXPIRED",
            stateChangedAt: observedAt,
            terminalReason: "candidate_deadline",
          },
        });
        const liveWaiters = await tx.capacityWaiter.count({
          where: {
            admissionRequestId: existing.id,
            state: "WAITING",
            OR: [{ deadlineAt: null }, { deadlineAt: { gt: observedAt } }],
          },
        });
        if (liveWaiters === 0) {
          await tx.admissionRequest.update({
            where: { id: existing.id },
            data: {
              state: "EXPIRED",
              terminalAt: observedAt,
              terminalReason: "candidate_deadlines",
            },
          });
          if (existing.relayRequestId)
            await tx.relayRequest.updateMany({
              where: { id: existing.relayRequestId, admissionAttemptId: attempt.attemptId },
              data: { admissionTerminalState: "EXPIRED" },
            });
          return { result: { state: "EXPIRED" } as const, notify: [] };
        }
      }

      const now = observedAt;
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
      const request =
        existing ??
        (await tx.admissionRequest.create({
          data: {
            userId: attempt.ownerId,
            requestId: attempt.requestId,
            relayRequestId: attempt.relayRequestId,
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
                deadlineAt: candidate.deadlineAt ?? attempt.deadlineAt,
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

      for (const capacityId of orderedCapacityIds) await this.#admitOne(tx, capacityId, now);
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
    await this.#notifyBestEffort(result.notify);
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
        const hasMemberConcurrencyOverride =
          member.capacityConcurrencyMode === "LIMITED" ||
          (member.capacityConcurrencyMode === undefined &&
            member.capacityConcurrencyLimit !== null);
        const memberConcurrencyCeiling =
          member.capacityConcurrencyMode === "UNLIMITED"
            ? undefined
            : hasMemberConcurrencyOverride
              ? (member.capacityConcurrencyLimit ?? undefined)
              : (member.ModelPool.capacityConcurrencyLimit ?? undefined);
        return {
          ...candidate,
          priority: member.capacityPriority ?? member.ModelPool.capacityPriority,
          memberConcurrencyCeiling,
          concurrencyScope:
            member.capacityConcurrencyMode === "INHERIT" ||
            (member.capacityConcurrencyMode === undefined &&
              member.capacityConcurrencyLimit === null)
              ? "POOL"
              : "MEMBER",
          concurrencyScopeId:
            member.capacityConcurrencyMode === "INHERIT" ||
            (member.capacityConcurrencyMode === undefined &&
              member.capacityConcurrencyLimit === null)
              ? member.ModelPool.id
              : member.id,
          reservedSlots: member.capacityReservedSlots ?? member.ModelPool.capacityReservedSlots,
          allowBorrowReserved:
            (member.capacityBorrowPolicy ?? member.ModelPool.capacityBorrowPolicy) === "WHEN_IDLE",
        };
      }),
    );
  }

  async #admitOne(tx: Prisma.TransactionClient, capacityId: string, now: Date): Promise<boolean> {
    await tx.capacityWaiter.updateMany({
      where: { capacityId, state: "WAITING", deadlineAt: { lte: now } },
      data: {
        state: "EXPIRED",
        stateChangedAt: now,
        terminalReason: "candidate_deadline",
      },
    });
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
        OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
        AdmissionRequest: {
          state: "WAITING",
          OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
        },
      },
      include: { AdmissionRequest: true, PoolMember: true },
    });
    const configuredReservationMembers = await tx.poolMember.findMany({
      // Every PRIMARY execution target sharing this physical capacity takes
      // part in the same reservation accounting, including provider-backed
      // primaries. PUBLIC_OVERFLOW remains outside the primary scheduler.
      where: {
        tier: "PRIMARY",
        ExecutionTarget: {
          inferenceCapacityId: capacityId,
        },
      },
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
    const concurrencyActiveByScope = new Map<string, number>();
    for (const waiter of waiters) {
      if (waiter.effectiveConcurrencyLimit === null) continue;
      const scopeKey = `${waiter.effectiveConcurrencyScope}:${waiter.effectiveConcurrencyScopeId}`;
      if (concurrencyActiveByScope.has(scopeKey)) continue;
      const scopedActive = await tx.capacityLease.count({
        where: {
          state: "ACTIVE",
          ...(waiter.effectiveConcurrencyScope === "POOL"
            ? { poolId: waiter.effectiveConcurrencyScopeId }
            : waiter.effectiveConcurrencyScope === "MEMBER"
              ? { poolMemberId: waiter.effectiveConcurrencyScopeId }
              : { executionTargetId: waiter.effectiveConcurrencyScopeId }),
        },
      });
      concurrencyActiveByScope.set(scopeKey, scopedActive);
    }
    const eligibility = new Map<string, { borrowed: boolean }>();
    const eligible = [];
    for (const waiter of waiters) {
      const memberLimit = waiter.effectiveConcurrencyLimit;
      if (memberLimit !== null && memberLimit !== undefined) {
        const memberActive =
          concurrencyActiveByScope.get(
            `${waiter.effectiveConcurrencyScope}:${waiter.effectiveConcurrencyScopeId}`,
          ) ?? 0;
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
          entry.effectivePriority > waiter.effectivePriority &&
          queuedOwner !== ownerKey &&
          (reservationsByOwner.get(queuedOwner) ?? 0) > (activeByOwner.get(queuedOwner) ?? 0) &&
          (entry.effectiveConcurrencyLimit === null ||
            (concurrencyActiveByScope.get(
              `${entry.effectiveConcurrencyScope}:${entry.effectiveConcurrencyScopeId}`,
            ) ?? 0) < entry.effectiveConcurrencyLimit)
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
    // A request may have sibling waiters on distinct physical capacities.
    // Serialize the winner at the durable request row, then re-read after the
    // lock. This makes the unique attemptId lease constraint a final invariant
    // rather than the normal arbitration mechanism (and avoids leaking P2002).
    await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${waiter.admissionRequestId} FOR UPDATE`;
    const winningRequest = await tx.admissionRequest.findUnique({
      where: { id: waiter.admissionRequestId },
      include: { Lease: true },
    });
    if (winningRequest?.state !== "WAITING" || winningRequest.Lease) return true;
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
      where: { admissionRequestId: waiter.admissionRequestId, state: "WAITING" },
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

  async #lockAdmissionResources(
    tx: Prisma.TransactionClient,
    capacityIds: readonly string[],
    additionalScopeKeys: readonly string[] = [],
  ): Promise<void> {
    const durableScopes = capacityIds.length
      ? await tx.capacityWaiter.findMany({
          where: {
            capacityId: { in: [...capacityIds] },
            effectiveConcurrencyLimit: { not: null },
          },
          select: {
            effectiveConcurrencyScope: true,
            effectiveConcurrencyScopeId: true,
          },
          distinct: ["effectiveConcurrencyScope", "effectiveConcurrencyScopeId"],
        })
      : [];
    const scopeKeys = durableScopes.map((waiter) =>
      concurrencyLockKey(waiter.effectiveConcurrencyScope, waiter.effectiveConcurrencyScopeId),
    );
    // All capacity operations use this two-phase order. Capacity IDs remain
    // the historical lock key shared with API policy mutations and process
    // workers; changing that key would silently split the lock domain.
    const orderedScopeKeys = [...new Set([...scopeKeys, ...additionalScopeKeys])].sort();
    for (const lockKey of orderedScopeKeys)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const orderedCapacityIds = [...new Set(capacityIds)].sort();
    for (const capacityId of orderedCapacityIds)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${capacityId}, 0))`;
    // Policy writers and admission both lock execution targets before reaching
    // this phase. Writers never acquire capacity admission locks afterwards;
    // taking capacity rows only after all sorted advisory locks therefore
    // preserves both orders. Crucially, the first capacity snapshot runs as a
    // new READ COMMITTED statement after a contended writer commits instead of
    // admitting against its stale pre-update limit.
    if (orderedCapacityIds.length > 0)
      await tx.$queryRaw`SELECT id FROM inference_capacity WHERE id IN (${Prisma.join(
        orderedCapacityIds,
      )}) ORDER BY id FOR UPDATE`;
  }

  async #lockExecutionTargetPolicies(
    tx: Prisma.TransactionClient,
    executionTargetIds: readonly string[],
  ): Promise<void> {
    // Keep this byte-for-byte lock-key compatible with
    // packages/api/src/lib/capacity-policy-safety.ts. Policy mutations that
    // affect multiple targets and admissions both use sorted target IDs.
    for (const targetId of [...new Set(executionTargetIds)].sort()) {
      await tx.$queryRaw`SELECT id FROM execution_target WHERE id = ${targetId} FOR UPDATE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${
        "capacity-policy:" + targetId
      }, 0))`;
    }
  }

  async heartbeat(lease: CapacityLeaseHandle, extensionMs: number): Promise<boolean> {
    if (!Number.isFinite(extensionMs) || extensionMs <= 0)
      throw new RangeError("Capacity lease extension must be a positive duration.");
    const boundedExtensionMs = Math.min(extensionMs, 5 * 60_000);
    return this.#serializable(async (tx) => {
      await this.#lockAdmissionResources(tx, [lease.capacityId]);
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clockRows[0]?.now;
      if (!now) throw new Error("Database clock unavailable.");
      const result = await tx.capacityLease.updateMany({
        where: {
          id: lease.leaseId,
          fencingToken: lease.fencingToken,
          state: "ACTIVE",
          expiresAt: { gt: now },
        },
        data: { heartbeatAt: now, expiresAt: new Date(now.getTime() + boundedExtensionMs) },
      });
      return result.count === 1;
    });
  }

  async release(lease: CapacityLeaseHandle): Promise<boolean> {
    const released = await this.db.$transaction(async (tx) => {
      await this.#lockAdmissionResources(tx, [lease.capacityId]);
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clockRows[0]?.now;
      if (!now) throw new Error("Database clock unavailable.");
      const result = await tx.capacityLease.updateMany({
        where: { id: lease.leaseId, fencingToken: lease.fencingToken, state: "ACTIVE" },
        data: { state: "RELEASED", releasedAt: now, releaseReason: "released" },
      });
      if (result.count)
        await tx.admissionRequest.updateMany({
          where: { attemptId: lease.attemptId, state: "ADMITTED" },
          data: { state: "TERMINAL", terminalAt: now },
        });
      if (result.count) {
        const admission = await tx.admissionRequest.findUnique({
          where: { attemptId: lease.attemptId },
          select: { relayRequestId: true },
        });
        if (admission?.relayRequestId)
          await tx.relayRequest.updateMany({
            where: { id: admission.relayRequestId, admissionAttemptId: lease.attemptId },
            data: { admissionTerminalState: "TERMINAL" },
          });
      }
      if (result.count) await this.#fillAvailable(tx, lease.capacityId, now);
      return result.count === 1;
    });
    if (released) await this.#notifyBestEffort([lease.capacityId]);
    return released;
  }

  async terminalizeAttempt(
    attemptId: string,
    state: "CANCELLED" | "EXPIRED",
  ): Promise<AdmissionTerminalizationResult> {
    const reason = state === "CANCELLED" ? "cancelled" : "deadline";
    const cancelled = await this.#serializable(async (tx) => {
      const request = await tx.admissionRequest.findUnique({
        where: { attemptId },
        include: { Waiters: true, Lease: true },
      });
      if (!request) return { result: { state: "MISSING" } as const, capacities: [] as string[] };
      const capacities = [...new Set(request.Waiters.map((waiter) => waiter.capacityId))].sort();
      if (request.Lease?.capacityId) capacities.push(request.Lease.capacityId);
      const lockedCapacities = [...new Set(capacities)].sort();
      await this.#lockAdmissionResources(tx, lockedCapacities);
      const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clockRows[0]?.now;
      if (!now) throw new Error("Database clock unavailable.");
      const current = await tx.admissionRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { Lease: true },
      });
      if (current.state === "ADMITTED" && current.Lease?.state === "ACTIVE")
        return {
          result: { state: "ADMITTED", lease: leaseHandle(current.Lease) } as const,
          capacities: lockedCapacities,
        };
      if (current.state !== "WAITING")
        return {
          result: {
            state:
              current.state === "CANCELLED" || current.state === "EXPIRED"
                ? current.state
                : "TERMINAL",
          } as AdmissionTerminalizationResult,
          capacities: lockedCapacities,
        };
      // Process clocks are only polling hints. A caller may ask to expire an
      // attempt before PostgreSQL's authoritative clock reaches the durable
      // deadline, so preserve the waiter and tell it to keep polling.
      if (state === "EXPIRED" && (!current.deadlineAt || current.deadlineAt > now))
        return {
          result: { state: "WAITING", requestId: current.id } as const,
          capacities: lockedCapacities,
        };
      const result = await tx.admissionRequest.updateMany({
        where: {
          id: request.id,
          state: "WAITING",
          ...(state === "EXPIRED" ? { deadlineAt: { lte: now } } : {}),
        },
        data: { state, terminalAt: now, terminalReason: reason },
      });
      if (result.count)
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: request.id, state: "WAITING" },
          data: { state, stateChangedAt: now, terminalReason: reason },
        });
      if (result.count && request.relayRequestId)
        await tx.relayRequest.updateMany({
          where: { id: request.relayRequestId, admissionAttemptId: attemptId },
          data: { admissionTerminalState: state },
        });
      return {
        result: { state: result.count ? state : "MISSING" } as AdmissionTerminalizationResult,
        capacities: lockedCapacities,
      };
    });
    if (cancelled.result.state === state) await this.#notifyBestEffort(cancelled.capacities);
    return cancelled.result;
  }

  /** @deprecated Prefer terminalizeAttempt so an admission race cannot be hidden. */
  async cancelAttempt(attemptId: string): Promise<boolean> {
    return (await this.terminalizeAttempt(attemptId, "CANCELLED")).state === "CANCELLED";
  }

  /** @deprecated Prefer terminalizeAttempt so an admission race cannot be hidden. */
  async expireAttempt(attemptId: string): Promise<boolean> {
    return (await this.terminalizeAttempt(attemptId, "EXPIRED")).state === "EXPIRED";
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
        await this.#lockAdmissionResources(tx, [lease.capacityId]);
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
          const admission = await tx.admissionRequest.findUnique({
            where: { id: lease.admissionRequestId },
            select: { relayRequestId: true },
          });
          if (admission?.relayRequestId)
            await tx.relayRequest.updateMany({
              where: { id: admission.relayRequestId, admissionAttemptId: lease.attemptId },
              data: { admissionTerminalState: "TERMINAL" },
            });
          await this.#fillAvailable(tx, lease.capacityId, lockedNow);
        }
        return update;
      });
      reclaimed += result.count;
      if (result.count) await this.#notifyBestEffort([lease.capacityId]);
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
        await this.#lockAdmissionResources(tx, capacities);
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
        if (current.relayRequestId)
          await tx.relayRequest.updateMany({
            where: { id: current.relayRequestId, admissionAttemptId: current.attemptId },
            data: { admissionTerminalState: expired ? "EXPIRED" : "CANCELLED" },
          });
        return capacities;
      });
      if (swept.length) {
        sweptRequests++;
        await this.#notifyBestEffort(swept);
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

function concurrencyLockKey(scope: string, scopeId: string): string {
  return `0:concurrency:${scope}:${scopeId}`;
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
  reservationClass: number;
  borrowed: boolean;
}): CapacityLeaseHandle {
  return {
    leaseId: lease.id,
    attemptId: lease.attemptId,
    capacityId: lease.capacityId,
    executionTargetId: lease.executionTargetId,
    ...(lease.poolMemberId ? { poolMemberId: lease.poolMemberId } : {}),
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
    reservationClass: lease.reservationClass,
    borrowed: lease.borrowed,
  };
}
