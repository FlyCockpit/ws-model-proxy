import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  acquireFences,
  type Fence,
  fenceCapacityAdmission,
  fences,
  isRetryableCapacityTransactionError,
  lockCrossCapacityAdmissionRequests,
} from "@ws-model-proxy/db/capacity-lock-order";
import { isDbShutdownFenceArmed, runWithDbShutdownPermit } from "@ws-model-proxy/db/shutdown-fence";
import { SCHEDULER_VERSION, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type {
  AdmissionAttempt,
  AdmissionResult,
  AdmissionTerminalizationResult,
  CapacityAdmissionStore,
  CapacityLeaseHandle,
} from "./types.js";

type Db = typeof prisma;

export { isRetryableCapacityTransactionError };

/**
 * A `relay_request.admissionTerminalState` projection. The store writes it
 * after its transaction commits, as its own single-row statement: no store
 * transaction ever waits on a relay row (see the admission-internal order in
 * @ws-model-proxy/db/capacity-lock-order).
 */
type RelayAdmissionProjection = {
  relayRequestId: string;
  admissionAttemptId: string;
  state: string;
};

/** Reason recorded on waiters, requests and leases whose graph parent was deleted. */
export const ORPHANED_REASON = "parent_deleted";

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
      // caller supplies a different candidate list on retry. This fence is
      // always taken before the capacity fences, giving every acquire
      // operation one deterministic global order.
      await acquireFences(tx, [fences.admissionAttempt(attempt.attemptId)]);
      let existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      // Policy writers take the capacity-policy fence of every target whose
      // pool/member/direct limits they change. Admission takes the same
      // fences before it resolves and persists the effective policy;
      // otherwise an unlimited admission on capacity A can race a pool-wide
      // unlimited -> limited update while another admission enters through
      // capacity B. No target row is locked: the graph is read without locks
      // after the fences (@ws-model-proxy/db/capacity-lock-order).
      const policyTargetIds = existing
        ? existing.Waiters.map((waiter) => waiter.executionTargetId)
        : attempt.candidates.map((candidate) => candidate.executionTargetId);
      await acquireFences(
        tx,
        policyTargetIds.map((targetId) => fences.capacityPolicy(targetId)),
      );
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
      const candidateScopeFences: Fence[] = existing
        ? existing.Waiters.flatMap((candidate) =>
            candidate.effectiveConcurrencyLimit === null
              ? []
              : [
                  fences.concurrencyScope(
                    candidate.effectiveConcurrencyScope,
                    candidate.effectiveConcurrencyScopeId,
                  ),
                ],
          )
        : resolvedCandidates.flatMap((candidate) =>
            candidate.memberConcurrencyCeiling === undefined
              ? []
              : [fences.concurrencyScope(candidate.concurrencyScope, candidate.concurrencyScopeId)],
          );
      // Every shared scope fence sorts before every physical-capacity fence.
      // Release/reclaim use the same order, preventing both cross-capacity
      // write skew and fence inversion.
      const capacityIds = [...orderedCapacityIds].sort();
      await fenceCapacityAdmission(tx, capacityIds, candidateScopeFences);
      // The initial graph read only discovers locks for an idempotent retry.
      // Re-read after all locks so every decision uses a fresh committed view.
      existing = await tx.admissionRequest.findUnique({
        where: { attemptId: attempt.attemptId },
        include: { Lease: true, Waiters: true },
      });
      // Admission-request rows: this request plus every queued request that
      // another admitter (one holding a capacity outside this set) can also
      // lock, in one sorted statement, before #admitOne locks any winner.
      await lockCrossCapacityAdmissionRequests(tx, capacityIds, existing ? [existing.id] : []);
      if (existing)
        await tx.$queryRaw`SELECT id FROM capacity_waiter WHERE "admissionRequestId" = ${existing.id} FOR UPDATE`;
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
        const reclaimed = await tx.capacityLease.updateMany({
          where: {
            id: existing.Lease.id,
            fencingToken: existing.Lease.fencingToken,
            state: "ACTIVE",
            expiresAt: { lte: lockedNow },
          },
          data: { state: "RECLAIMED", releasedAt: lockedNow, releaseReason: "expired" },
        });
        // Heartbeat takes only the lease row; it may renew after our read.
        if (!reclaimed.count) {
          const renewed = await tx.capacityLease.findUniqueOrThrow({
            where: { id: existing.Lease.id },
          });
          if (renewed.state === "ACTIVE")
            return {
              result: { state: "ADMITTED", lease: leaseHandle(renewed) } as const,
              notify: [],
            };
        }
        await tx.admissionRequest.update({
          where: { id: existing.id },
          data: { state: "TERMINAL", terminalAt: lockedNow, terminalReason: "lease_expired" },
        });
        return {
          result: { state: "EXPIRED" } as const,
          notify: [existing.Lease.capacityId],
          relay: relayProjection(existing.relayRequestId, attempt.attemptId, "TERMINAL"),
        };
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
        return {
          result: { state: "EXPIRED" } as const,
          notify: [],
          relay: relayProjection(existing.relayRequestId, attempt.attemptId, "EXPIRED"),
        };
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
          return {
            result: { state: "EXPIRED" } as const,
            notify: [],
            relay: relayProjection(existing.relayRequestId, attempt.attemptId, "EXPIRED"),
          };
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
                deadlineAt: candidateDeadlineAt(candidate, attempt.deadlineAt, now),
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

      // A newly created attempt may carry zero wait budgets, whose DB-clock
      // deadline is exactly `now`. They are eligible in THIS transaction only
      // ("admit only if free now"), so the creating pass admits them before
      // the deadline sweep; afterwards they expire below. Orphaned waiters of
      // other requests that #admitOne cancels on the way leave projections.
      const admitted: RelayAdmissionProjection[] = [];
      for (const capacityId of orderedCapacityIds)
        await this.#admitOne(tx, capacityId, now, existing ? undefined : request.id, admitted);
      const refreshed = await tx.admissionRequest.findUniqueOrThrow({
        where: { id: request.id },
        include: { Lease: true },
      });
      if (refreshed.Lease?.state === "ACTIVE")
        return {
          result: { state: "ADMITTED", lease: leaseHandle(refreshed.Lease) } as const,
          notify: capacityIds,
          relay: admitted,
        };
      if (!existing) {
        const expiredNow = await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: request.id, state: "WAITING", deadlineAt: { lte: now } },
          data: { state: "EXPIRED", stateChangedAt: now, terminalReason: "candidate_deadline" },
        });
        if (expiredNow.count > 0) {
          const liveWaiters = await tx.capacityWaiter.count({
            where: { admissionRequestId: request.id, state: "WAITING" },
          });
          if (liveWaiters === 0) {
            await tx.admissionRequest.update({
              where: { id: request.id },
              data: { state: "EXPIRED", terminalAt: now, terminalReason: "candidate_deadlines" },
            });
            return {
              result: { state: "EXPIRED" } as const,
              notify: capacityIds,
              relay: [
                ...admitted,
                ...relayProjection(request.relayRequestId, attempt.attemptId, "EXPIRED"),
              ],
            };
          }
        }
      }
      return {
        result: { state: "WAITING", requestId: refreshed.id } as const,
        notify: capacityIds,
        relay: admitted,
      };
    });
    await this.#projectRelayAdmissionStates(("relay" in result ? result.relay : undefined) ?? []);
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

  /**
   * The capacity's durable scheduler state (`capacity_runtime`, writer class
   * H). Created on first use under the capacity fence the caller holds, with
   * a fencing token above every lease token the capacity ever issued.
   */
  async #capacityRuntime(tx: Prisma.TransactionClient, capacityId: string, userId: string) {
    await tx.$executeRaw`
      INSERT INTO capacity_runtime ("capacityId", "userId", "nextFencingToken")
      SELECT ${capacityId}, ${userId}, COALESCE(MAX(lease."fencingToken"), 0) + 1
        FROM capacity_lease lease WHERE lease."capacityId" = ${capacityId}
      ON CONFLICT ("capacityId") DO NOTHING`;
    return tx.capacityRuntime.findUniqueOrThrow({ where: { capacityId } });
  }

  /**
   * Whether the graph still carries `waiter`: its target exists on this
   * capacity and, for a pool candidate, its member still joins that pool and
   * target. A waiter whose parent was deleted (or moved to another capacity)
   * is an orphan: admitting it would lease a slot nobody can use.
   */
  async #waiterGraphIsLive(
    tx: Prisma.TransactionClient,
    waiter: { executionTargetId: string; poolId: string | null; poolMemberId: string | null },
    capacityId: string,
  ): Promise<boolean> {
    const target = await tx.executionTarget.findUnique({
      where: { id: waiter.executionTargetId },
      select: { inferenceCapacityId: true },
    });
    if (target?.inferenceCapacityId !== capacityId) return false;
    if (!waiter.poolMemberId) return true;
    const member = await tx.poolMember.findUnique({
      where: { id: waiter.poolMemberId },
      select: { poolId: true, executionTargetId: true },
    });
    return (
      member?.poolId === waiter.poolId && member.executionTargetId === waiter.executionTargetId
    );
  }

  /**
   * Cancels an orphaned waiter of a request whose row the caller holds,
   * and the request itself once it has no live waiter left.
   */
  async #cancelOrphanedWaiter(
    tx: Prisma.TransactionClient,
    waiter: { id: string; admissionRequestId: string },
    now: Date,
    projections: RelayAdmissionProjection[],
  ): Promise<void> {
    await tx.capacityWaiter.updateMany({
      where: { id: waiter.id, state: "WAITING" },
      data: { state: "CANCELLED", stateChangedAt: now, terminalReason: ORPHANED_REASON },
    });
    const live = await tx.capacityWaiter.count({
      where: { admissionRequestId: waiter.admissionRequestId, state: "WAITING" },
    });
    if (live > 0) return;
    const request = await tx.admissionRequest.findUnique({
      where: { id: waiter.admissionRequestId },
      select: { state: true, relayRequestId: true, attemptId: true },
    });
    if (request?.state !== "WAITING") return;
    await tx.admissionRequest.update({
      where: { id: waiter.admissionRequestId },
      data: { state: "CANCELLED", terminalAt: now, terminalReason: ORPHANED_REASON },
    });
    projections.push(...relayProjection(request.relayRequestId, request.attemptId, "CANCELLED"));
  }

  async #admitOne(
    tx: Prisma.TransactionClient,
    capacityId: string,
    now: Date,
    /** The attempt created in this transaction: its zero-budget waiters are still eligible. */
    creatingRequestId: string | undefined,
    projections: RelayAdmissionProjection[],
  ): Promise<boolean> {
    await tx.capacityWaiter.updateMany({
      where: {
        capacityId,
        state: "WAITING",
        deadlineAt: { lte: now },
        ...(creatingRequestId ? { NOT: { admissionRequestId: creatingRequestId } } : {}),
      },
      data: {
        state: "EXPIRED",
        stateChangedAt: now,
        terminalReason: "candidate_deadline",
      },
    });
    // A graph row, read without a lock: the capacity fence the caller holds
    // excludes every writer of its policy. A deleted capacity admits nothing;
    // its waiters are orphans the capacity sweeper terminalizes.
    const capacity = await tx.inferenceCapacity.findUnique({
      where: { id: capacityId },
      select: { userId: true, hardConcurrencyLimit: true },
    });
    if (!capacity) return false;
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
        OR: [
          { deadlineAt: null },
          { deadlineAt: { gt: now } },
          ...(creatingRequestId
            ? [{ admissionRequestId: creatingRequestId, deadlineAt: { gte: now } }]
            : []),
        ],
        AdmissionRequest: {
          state: "WAITING",
          OR: [
            { deadlineAt: null },
            { deadlineAt: { gt: now } },
            ...(creatingRequestId ? [{ id: creatingRequestId }] : []),
          ],
        },
      },
      include: { AdmissionRequest: true },
    });
    const configuredReservationMembers = await tx.poolMember.findMany({
      // Every PRIMARY (always local) execution target sharing this physical
      // capacity takes part in the same reservation accounting. External
      // fallback (PUBLIC_OVERFLOW) members stay outside the primary scheduler.
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
    const runtime = await this.#capacityRuntime(tx, capacityId, capacity.userId);
    const deficits = schedulerDeficits(runtime.schedulerDeficits);
    const decision = scheduleWeightedDeficitRoundRobin({
      candidates: eligible,
      state: { cursor: runtime.schedulerCursor, deficits, version: runtime.schedulerVersion },
    });
    if (!decision.winner) return false;
    const waiter = waiters.find((entry) => entry.id === decision.winner?.waiterId);
    if (!waiter) return false;
    // A request may have sibling waiters on distinct physical capacities.
    // Serialize the winner at the durable request row, then re-read after the
    // lock. This makes the unique attemptId lease constraint a final invariant
    // rather than the normal arbitration mechanism (and avoids leaking P2002).
    // A winner that another admitter can also reach was already locked, in
    // sorted order, by lockCrossCapacityAdmissionRequests; any other winner's
    // row is reachable only through capacity fences this transaction holds.
    await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ${waiter.admissionRequestId} FOR UPDATE`;
    const winningRequest = await tx.admissionRequest.findUnique({
      where: { id: waiter.admissionRequestId },
      include: { Lease: true },
    });
    if (winningRequest?.state !== "WAITING" || winningRequest.Lease) return true;
    // No foreign key keeps the graph behind a waiter (DL-1 design (d)): a
    // candidate whose target, member or pool was deleted, or whose target
    // moved to another capacity, is cancelled here instead of leased.
    if (!(await this.#waiterGraphIsLive(tx, waiter, capacityId))) {
      await this.#cancelOrphanedWaiter(tx, waiter, now, projections);
      return true;
    }
    // G2n pass 5: the shutdown fence can arm DURING any await of this loop
    // (release/reclamation run under the durable-cleanup permit, so their
    // operations keep flowing after the fence arms). The durable admission
    // sequence starts HERE — fencing-token/scheduler update, lease create,
    // WAITING→ADMITTED — so this is the per-iteration stop point: once the
    // fence is armed, no NEW admission may start. A sequence that already
    // started (the check passed) is allowed to complete — its partial work
    // is committed durable state, not a new admission.
    if (isDbShutdownFenceArmed()) return false;
    const updatedRuntime = await tx.capacityRuntime.update({
      where: { capacityId },
      data: {
        schedulerCursor: decision.state.cursor,
        schedulerDeficits: decision.state.deficits,
        schedulerVersion: SCHEDULER_VERSION,
        nextFencingToken: { increment: 1 },
      },
    });
    const fencingToken = updatedRuntime.nextFencingToken - 1n;
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

  async #fillAvailable(
    tx: Prisma.TransactionClient,
    capacityId: string,
    now: Date,
    projections: RelayAdmissionProjection[],
  ) {
    // G2n permit-scope (pass 4): admission scheduling during teardown is NEW
    // work, never durable cleanup. release() runs inside the shutdown
    // permit (its ACTIVE→RELEASED transitions must complete), and this fill
    // previously inherited that permit — authorizing capacityLease.create
    // and WAITING→ADMITTED for OTHER requests while the process is tearing
    // down. When the global shutdown fence is armed, skip the fill: queued
    // waiters remain WAITING and are admitted by the next boot (or their
    // own deadlines) — the correct teardown semantic. Normal-operation
    // aborts (fence NOT armed) keep filling: one request going away and
    // admitting the next waiter is ordinary capacity behavior.
    //
    // G2n pass 5: the fence can arm DURING the loop's awaits, so the check
    // is PER ITERATION (loop entry AND inside #admitOne immediately before
    // the durable admission sequence), not once at entry — a fence that
    // arms mid-fill stops the very next admission instead of authorizing
    // the whole remaining queue. Both callers (release and reclamation)
    // run through this same loop.
    while (
      !isDbShutdownFenceArmed() &&
      (await this.#admitOne(tx, capacityId, now, undefined, projections))
    ) {
      // Each iteration consumes one durable waiter and rechecks physical/member
      // limits, so this terminates without relying on a caller-provided bound.
    }
  }

  /** Capacity fences plus the cross-capacity request locks, for transactions that run #fillAvailable. */
  async #fenceFill(
    tx: Prisma.TransactionClient,
    capacityId: string,
    options: { wait?: boolean } = {},
  ): Promise<boolean> {
    if (!(await fenceCapacityAdmission(tx, [capacityId], [], options))) return false;
    await lockCrossCapacityAdmissionRequests(tx, [capacityId]);
    return true;
  }

  /**
   * Writes the relay admission-state projections a committed store
   * transaction produced, each as its own single-row statement holding
   * nothing else. Telemetry only: a failure is logged, never raised, and
   * leaves the relay row's `admissionTerminalState` stale.
   */
  async #projectRelayAdmissionStates(projections: readonly RelayAdmissionProjection[]) {
    for (const projection of projections) {
      try {
        await this.db.relayRequest.updateMany({
          where: {
            id: projection.relayRequestId,
            admissionAttemptId: projection.admissionAttemptId,
          },
          data: { admissionTerminalState: projection.state },
        });
      } catch (error) {
        console.warn("[capacity] relay admission-state projection failed", {
          errorClass: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
  }

  async heartbeat(lease: CapacityLeaseHandle, extensionMs: number): Promise<boolean> {
    if (!Number.isFinite(extensionMs) || extensionMs <= 0)
      throw new RangeError("Capacity lease extension must be a positive duration.");
    const boundedExtensionMs = Math.min(extensionMs, 5 * 60_000);
    // Single-row UPDATE, holding no fence and no other row.
    // PostgreSQL rechecks the predicate after a concurrent release/reclaim.
    // Use its clock at execution, never the caller's process clock.
    const count = await this.db.$executeRaw`
      UPDATE capacity_lease
      SET ("heartbeatAt", "expiresAt") = (
        SELECT now, now + (${boundedExtensionMs} * interval '1 millisecond')
        FROM (SELECT clock_timestamp() AS now) AS heartbeat_clock
      )
      WHERE id = ${lease.leaseId} AND "fencingToken" = ${lease.fencingToken}
        AND state = 'ACTIVE' AND "expiresAt" > clock_timestamp()
    `;
    return count === 1;
  }

  async release(lease: CapacityLeaseHandle): Promise<boolean> {
    // G2n (durable-cleanup permit): release runs AFTER the caller's abort
    // BY DESIGN (response-lease cleanup fires on abort/EOF/cancel), and the
    // MCP shutdown gate arms the global DB fence BEFORE aborting. The
    // permit exempts ONLY this release from the fences — the ACTIVE→
    // RELEASED lease transition and ADMITTED→TERMINAL request transition
    // are durable cleanup intent that must complete during teardown, while
    // every NEW (non-cleanup) operation stays fenced.
    //
    // The permit wraps the store's retry wrapper, so a retried attempt after a
    // 40001/40P01 abort keeps the same durable-cleanup exemption.
    const released = await runWithDbShutdownPermit(() =>
      this.#serializable(async (tx) => {
        const projections: RelayAdmissionProjection[] = [];
        await this.#fenceFill(tx, lease.capacityId);
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
          projections.push(
            ...relayProjection(admission?.relayRequestId, lease.attemptId, "TERMINAL"),
          );
        }
        if (result.count) await this.#fillAvailable(tx, lease.capacityId, now, projections);
        return { released: result.count === 1, projections };
      }),
    );
    await this.#projectRelayAdmissionStates(released.projections);
    if (released.released) await this.#notifyBestEffort([lease.capacityId]);
    return released.released;
  }

  async terminalizeAttempt(
    attemptId: string,
    state: "CANCELLED" | "EXPIRED",
  ): Promise<AdmissionTerminalizationResult> {
    const reason = state === "CANCELLED" ? "cancelled" : "deadline";
    // G2n (durable-cleanup permit): the WAITING→CANCELLED/EXPIRED waiter
    // transition is abort-triggered durable cleanup — it must execute even
    // after the shutdown fence armed and the request's signal aborted.
    const cancelled = await runWithDbShutdownPermit(() =>
      this.#serializable(async (tx) => {
        const request = await tx.admissionRequest.findUnique({
          where: { attemptId },
          include: { Waiters: true, Lease: true },
        });
        if (!request)
          return {
            result: { state: "MISSING" } as const,
            capacities: [] as string[],
            projections: [] as RelayAdmissionProjection[],
          };
        const capacities = [...new Set(request.Waiters.map((waiter) => waiter.capacityId))].sort();
        if (request.Lease?.capacityId) capacities.push(request.Lease.capacityId);
        const lockedCapacities = [...new Set(capacities)].sort();
        await fenceCapacityAdmission(tx, lockedCapacities);
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
            projections: [] as RelayAdmissionProjection[],
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
            projections: [] as RelayAdmissionProjection[],
          };
        // Process clocks are only polling hints. A caller may ask to expire an
        // attempt before PostgreSQL's authoritative clock reaches the durable
        // deadline, so preserve the waiter and tell it to keep polling.
        if (state === "EXPIRED" && (!current.deadlineAt || current.deadlineAt > now))
          return {
            result: { state: "WAITING", requestId: current.id } as const,
            capacities: lockedCapacities,
            projections: [] as RelayAdmissionProjection[],
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
        return {
          result: { state: result.count ? state : "MISSING" } as AdmissionTerminalizationResult,
          capacities: lockedCapacities,
          projections: result.count
            ? relayProjection(request.relayRequestId, attemptId, state)
            : [],
        };
      }),
    );
    await this.#projectRelayAdmissionStates(cancelled.projections);
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
        const projections: RelayAdmissionProjection[] = [];
        await this.#fenceFill(tx, lease.capacityId);
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
          projections.push(
            ...relayProjection(admission?.relayRequestId, lease.attemptId, "TERMINAL"),
          );
          await this.#fillAvailable(tx, lease.capacityId, lockedNow, projections);
        }
        return { count: update.count, projections };
      });
      await this.#projectRelayAdmissionStates(result.projections);
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
        if (current?.state !== "WAITING")
          return { capacities: [] as string[], projections: [] as RelayAdmissionProjection[] };
        const capacities = [...new Set(current.Waiters.map((waiter) => waiter.capacityId))].sort();
        await fenceCapacityAdmission(tx, capacities);
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
          return { capacities: [] as string[], projections: [] as RelayAdmissionProjection[] };
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
        if (!updated.count)
          return { capacities: [] as string[], projections: [] as RelayAdmissionProjection[] };
        await tx.capacityWaiter.updateMany({
          where: { admissionRequestId: current.id, state: "WAITING" },
          data: {
            state: expired ? "EXPIRED" : "CANCELLED",
            stateChangedAt: lockedNow,
            terminalReason: expired ? "deadline" : "connection_abandoned",
          },
        });
        return {
          capacities,
          projections: relayProjection(
            current.relayRequestId,
            current.attemptId,
            expired ? "EXPIRED" : "CANCELLED",
          ),
        };
      });
      await this.#projectRelayAdmissionStates(swept.projections);
      if (swept.capacities.length) {
        sweptRequests++;
        await this.#notifyBestEffort(swept.capacities);
      }
    }
    const orphans = await this.sweepOrphans({ limit });
    return {
      requests: sweptRequests,
      leases: await this.reclaimExpired(now, limit),
      orphans,
    };
  }

  /**
   * Capacity orphan sweep (writer class S). Hot-path rows keep plain ids of
   * their graph parents, so a delete of a capacity, target, pool member or
   * user leaves its live admission rows behind. This sweep cancels every
   * WAITING waiter whose parent is gone (the request with it once no live
   * waiter is left) and releases every ACTIVE lease whose capacity or target
   * is gone, then refills the capacity. It never waits: it takes each
   * request's capacity fences with `{ wait: false }` and passes a busy one to
   * the next run, and it takes rows only under those fences. Returns the
   * number of requests and leases it terminalized.
   */
  async sweepOrphans({ limit }: { limit: number }): Promise<number> {
    const candidates = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT request.id FROM admission_request request
       WHERE request.state IN ('WAITING', 'ADMITTED')
         AND (NOT EXISTS (SELECT 1 FROM "user" owner WHERE owner.id = request."userId")
           OR EXISTS (
             SELECT 1 FROM capacity_waiter waiter
               LEFT JOIN execution_target target ON target.id = waiter."executionTargetId"
               LEFT JOIN pool_member member ON member.id = waiter."poolMemberId"
              WHERE waiter."admissionRequestId" = request.id
                AND waiter.state = 'WAITING'
                AND (target.id IS NULL
                  OR target."inferenceCapacityId" IS DISTINCT FROM waiter."capacityId"
                  OR (waiter."poolMemberId" IS NOT NULL AND member.id IS NULL)))
           OR EXISTS (
             SELECT 1 FROM capacity_lease lease
               LEFT JOIN execution_target target ON target.id = lease."executionTargetId"
               LEFT JOIN inference_capacity capacity ON capacity.id = lease."capacityId"
              WHERE lease."admissionRequestId" = request.id
                AND lease.state = 'ACTIVE'
                AND (target.id IS NULL OR capacity.id IS NULL)))
       ORDER BY request.id
       LIMIT ${Math.max(1, Math.trunc(limit))}`;
    let terminalized = 0;
    for (const { id } of candidates) {
      if (isDbShutdownFenceArmed()) break;
      const outcome = await this.#serializable(async (tx) => {
        const projections: RelayAdmissionProjection[] = [];
        const request = await tx.admissionRequest.findUnique({
          where: { id },
          include: { Waiters: true, Lease: true },
        });
        if (!request || (request.state !== "WAITING" && request.state !== "ADMITTED"))
          return { count: 0, capacities: [] as string[], projections };
        const capacities = [
          ...new Set([
            ...request.Waiters.map((waiter) => waiter.capacityId),
            ...(request.Lease ? [request.Lease.capacityId] : []),
          ]),
        ].sort();
        if (!(await fenceCapacityAdmission(tx, capacities, [], { wait: false })))
          return { count: 0, capacities: [] as string[], projections };
        const ownerGone =
          (await tx.user.findUnique({ where: { id: request.userId }, select: { id: true } })) ===
          null;
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM admission_request WHERE id = ${id} FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return { count: 0, capacities: [] as string[], projections };
        const clockRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        const now = clockRows[0]?.now;
        if (!now) throw new Error("Database clock unavailable.");
        let count = 0;
        const touched = new Set<string>();
        if (request.state === "WAITING") {
          for (const waiter of request.Waiters) {
            if (waiter.state !== "WAITING") continue;
            if (!ownerGone && (await this.#waiterGraphIsLive(tx, waiter, waiter.capacityId)))
              continue;
            await this.#cancelOrphanedWaiter(tx, waiter, now, projections);
            touched.add(waiter.capacityId);
          }
          const after = await tx.admissionRequest.findUniqueOrThrow({ where: { id } });
          if (after.state !== "WAITING") count += 1;
        } else if (request.Lease?.state === "ACTIVE") {
          const lease = request.Lease;
          const [target, capacity] = await Promise.all([
            tx.executionTarget.findUnique({
              where: { id: lease.executionTargetId },
              select: { id: true },
            }),
            tx.inferenceCapacity.findUnique({
              where: { id: lease.capacityId },
              select: { id: true },
            }),
          ]);
          if (!target || !capacity || ownerGone) {
            const released = await tx.capacityLease.updateMany({
              where: { id: lease.id, fencingToken: lease.fencingToken, state: "ACTIVE" },
              data: { state: "RELEASED", releasedAt: now, releaseReason: ORPHANED_REASON },
            });
            if (released.count) {
              await tx.admissionRequest.updateMany({
                where: { id, state: "ADMITTED" },
                data: { state: "TERMINAL", terminalAt: now, terminalReason: ORPHANED_REASON },
              });
              projections.push(
                ...relayProjection(request.relayRequestId, request.attemptId, "TERMINAL"),
              );
              touched.add(lease.capacityId);
              count += 1;
            }
          }
        }
        // A cancelled waiter or released lease can free a slot for another
        // waiter on the same capacity; the cross-capacity request locks come
        // after the fences, as in release.
        for (const capacityId of [...touched].sort()) {
          await lockCrossCapacityAdmissionRequests(tx, [capacityId]);
          await this.#fillAvailable(tx, capacityId, now, projections);
        }
        return { count, capacities: [...touched], projections };
      });
      await this.#projectRelayAdmissionStates(outcome.projections);
      terminalized += outcome.count;
      if (outcome.capacities.length) await this.#notifyBestEffort(outcome.capacities);
    }
    return terminalized;
  }

  async #serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runCapacitySerializable(this.db, work);
  }
}

function relayProjection(
  relayRequestId: string | null | undefined,
  admissionAttemptId: string,
  state: string,
): RelayAdmissionProjection[] {
  return relayRequestId ? [{ relayRequestId, admissionAttemptId, state }] : [];
}

/**
 * Effective candidate deadline on the database clock (`now` is the in-
 * transaction clock_timestamp()). Process clocks never decide a wait budget.
 */
export function candidateDeadlineAt(
  candidate: { deadlineAt?: Date; waitBudgetMs?: number | null },
  attemptDeadlineAt: Date,
  now: Date,
): Date {
  const upperBound = candidate.deadlineAt ?? attemptDeadlineAt;
  if (candidate.waitBudgetMs === undefined || candidate.waitBudgetMs === null) return upperBound;
  const budgetMs = Number.isFinite(candidate.waitBudgetMs)
    ? Math.max(0, Math.floor(candidate.waitBudgetMs))
    : 0;
  const relative = new Date(now.getTime() + budgetMs);
  return relative < upperBound ? relative : upperBound;
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
