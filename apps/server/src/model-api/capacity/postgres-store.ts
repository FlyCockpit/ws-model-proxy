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
import {
  type AdmissionSnapshot,
  type GrantPlan,
  type PlannedGrant,
  type PlannerWaiter,
  planGrants,
} from "./admission-planner.js";
import { SCHEDULER_VERSION } from "./scheduler.js";
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

/** What the write phase needs of a WAITING waiter to create its lease. */
type AdmissionWaiterRow = {
  userId: string;
  requestId: string;
  attemptId: string;
  admissionRequestId: string;
  executionTargetId: string;
  poolId: string | null;
  poolMemberId: string | null;
  priority: number;
};

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

/** Terminal reason of a waiter whose member became unroutable while it queued. */
export const MEMBER_UNROUTABLE_REASON = "member_unroutable";

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
      // L6: this request plus every queued request that another admitter
      // (one holding a capacity outside this set) can also lock, in one
      // sorted statement, before #persistGrants locks any winner.
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

      // Saturation S-A: a deferred waiter (notBefore set) must get at least one
      // admission check after it becomes eligible, even when this poll was
      // delayed past its deadline (e.g. by contended capacity locks). Every
      // poll and the creating pass run admission and stamp heartbeatAt on the
      // request, so a deferred waiter whose notBefore is later than the
      // previous poll has never been checked by its owner: it takes part in
      // this poll's admission pass once ("last chance") and expires after it
      // if not granted. The request's absolute deadline still applies above.
      const previousPollAt = existing?.heartbeatAt;
      const lastChanceWaiterIds = existing
        ? existing.Waiters.filter(
            (waiter) =>
              waiter.state === "WAITING" &&
              waiter.notBefore !== null &&
              previousPollAt !== undefined &&
              waiter.notBefore > previousPollAt &&
              waiter.deadlineAt !== null &&
              waiter.deadlineAt <= observedAt,
          ).map((waiter) => waiter.id)
        : [];
      if (existing) {
        await tx.capacityWaiter.updateMany({
          where: {
            admissionRequestId: existing.id,
            state: "WAITING",
            deadlineAt: { lte: observedAt },
            ...(lastChanceWaiterIds.length ? { id: { notIn: lastChanceWaiterIds } } : {}),
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
            OR: [
              { deadlineAt: null },
              { deadlineAt: { gt: observedAt } },
              ...(lastChanceWaiterIds.length ? [{ id: { in: lastChanceWaiterIds } }] : []),
            ],
          },
        });
        if (liveWaiters === 0) {
          await tx.admissionRequest.update({
            where: { id: existing.id },
            data: {
              state: "EXPIRED",
              terminalAt: observedAt,
              terminalReason: await noLiveCandidateReason(tx, existing.id),
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
      // A retry round may re-anchor to an earlier attempt of the same relay
      // request (plain read; the anchor row is never locked or written).
      const anchorRow =
        !existing && attempt.schedule
          ? await tx.admissionRequest.findUnique({
              where: { attemptId: attempt.schedule.anchorAttemptId },
              select: { enqueuedAt: true, userId: true, relayRequestId: true },
            })
          : null;
      const scheduleAnchor =
        anchorRow &&
        attempt.schedule &&
        anchorRow.userId === attempt.ownerId &&
        anchorRow.relayRequestId === (attempt.relayRequestId ?? null)
          ? { at: anchorRow.enqueuedAt, spillDelayMs: attempt.schedule.spillDelayMs }
          : undefined;
      const schedules = existing
        ? []
        : candidateSchedules(resolvedCandidates, attempt.deadlineAt, now, scheduleAnchor);
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
            // The database-clock schedule anchor of this attempt (see
            // AdmissionAttempt.schedule); never a process clock. The hardening
            // check keeps deadlineAt >= enqueuedAt: an attempt already past
            // its deadline expires at once, so its anchor is never used.
            enqueuedAt: attempt.deadlineAt < now ? attempt.deadlineAt : now,
            deadlineAt: attempt.deadlineAt,
            connectionOwner: attempt.connectionOwner,
            heartbeatAt: now,
            Waiters: {
              create: resolvedCandidates.map((candidate, index) => ({
                userId: attempt.ownerId,
                requestId: attempt.requestId,
                attemptId: attempt.attemptId,
                enqueueSequence,
                capacityId: candidate.capacityId,
                executionTargetId: candidate.executionTargetId,
                poolId: attempt.poolId,
                poolMemberId: candidate.poolMemberId,
                candidateOrder: candidate.candidateOrder,
                deadlineAt: schedules[index]!.deadlineAt,
                notBefore: schedules[index]!.notBefore,
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
      // other requests that #admitCapacity cancels on the way leave projections.
      const admitted: RelayAdmissionProjection[] = [];
      for (const capacityId of orderedCapacityIds)
        await this.#admitCapacity(tx, capacityId, now, admitted, {
          requestId: request.id,
          creatingRequestId: existing ? undefined : request.id,
          lastChanceWaiterIds,
        });
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
      // Zero budgets of a new attempt, and last-chance deferred waiters of a
      // poll, had their one admission check in this pass: expire them now.
      await tx.capacityWaiter.updateMany({
        where: { admissionRequestId: request.id, state: "WAITING", deadlineAt: { lte: now } },
        data: { state: "EXPIRED", stateChangedAt: now, terminalReason: "candidate_deadline" },
      });
      // Every candidate of this request may have been terminalized in this
      // pass: zero budgets of a new attempt, or members that became
      // unroutable (grant-time re-check). Then the request moves on now
      // instead of polling a request that can never be granted.
      const liveWaiters = await tx.capacityWaiter.count({
        where: { admissionRequestId: request.id, state: "WAITING" },
      });
      if (liveWaiters === 0) {
        await tx.admissionRequest.update({
          where: { id: request.id },
          data: {
            state: "EXPIRED",
            terminalAt: now,
            terminalReason: await noLiveCandidateReason(tx, request.id),
          },
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

  /**
   * Cancels the queued waiters of `capacityId` whose graph parent is gone and
   * returns the live ones. Two batched plain reads (target, member); the
   * cancellation follows #cancelOrphanedWaiter.
   */
  async #dropOrphanedWaiters<
    W extends {
      id: string;
      admissionRequestId: string;
      executionTargetId: string;
      poolId: string | null;
      poolMemberId: string | null;
    },
  >(
    tx: Prisma.TransactionClient,
    capacityId: string,
    waiters: readonly W[],
    now: Date,
    projections: RelayAdmissionProjection[],
  ): Promise<W[]> {
    if (!waiters.length) return [...waiters];
    const liveTargets = new Set(
      (
        await tx.executionTarget.findMany({
          where: {
            id: { in: [...new Set(waiters.map((waiter) => waiter.executionTargetId))] },
            inferenceCapacityId: capacityId,
          },
          select: { id: true },
        })
      ).map((target) => target.id),
    );
    const memberIds = [
      ...new Set(waiters.flatMap((waiter) => (waiter.poolMemberId ? [waiter.poolMemberId] : []))),
    ];
    const members = new Map(
      (memberIds.length
        ? await tx.poolMember.findMany({
            where: { id: { in: memberIds } },
            select: { id: true, poolId: true, executionTargetId: true },
          })
        : []
      ).map((member) => [member.id, member]),
    );
    const live: W[] = [];
    for (const waiter of waiters) {
      const member = waiter.poolMemberId ? members.get(waiter.poolMemberId) : undefined;
      const alive =
        liveTargets.has(waiter.executionTargetId) &&
        (!waiter.poolMemberId ||
          (member?.poolId === waiter.poolId &&
            member.executionTargetId === waiter.executionTargetId));
      if (alive) live.push(waiter);
      else await this.#cancelOrphanedWaiter(tx, waiter, now, projections);
    }
    return live;
  }

  /**
   * READ phase of an admission pass on one capacity: the deadline and
   * routability sweeps, then ONE snapshot of everything the planner needs
   * (capacity, ACTIVE leases, WAITING waiters, reservation members and direct
   * targets, per-scope lease counts). Every read happens under the L4/L6 locks
   * the caller already holds; this adds no lock.
   */
  async #readAdmissionSnapshot(
    tx: Prisma.TransactionClient,
    capacityId: string,
    now: Date,
    /** The attempt created in this transaction: its zero-budget waiters are still eligible. */
    creatingRequestId: string | undefined,
    projections: RelayAdmissionProjection[],
  ): Promise<{
    snapshot: AdmissionSnapshot;
    rows: Map<string, AdmissionWaiterRow>;
    userId: string;
  } | null> {
    await tx.capacityWaiter.updateMany({
      where: {
        capacityId,
        state: "WAITING",
        deadlineAt: { lte: now },
        // Deferred waiters are expired by their owner's poll, after the
        // last-chance check it owes them (see acquire), never by another
        // admitter's pass that may run before that check.
        notBefore: null,
        ...(creatingRequestId ? { NOT: { admissionRequestId: creatingRequestId } } : {}),
      },
      data: {
        state: "EXPIRED",
        stateChangedAt: now,
        terminalReason: "candidate_deadline",
      },
    });
    // Grant-time routability re-check (DB state only). The policy snapshot on
    // a waiter is frozen at enqueue, but its member may have been drained,
    // disabled, or (local members) zero-weighted or put into an UNHEALTHY
    // cooldown while it
    // queued. Such a waiter must neither be granted nor wait forever: it is
    // terminalized here, even while the capacity is full, and its request
    // expires on its own next poll when no live candidate remains (the other
    // candidates keep waiting). The pool_member read is a plain subquery (no
    // row lock), so it adds no lock-order edge; waiter rows are written under
    // this capacity's L4 lock, like the deadline sweep above. CLI connection
    // state is per process and stays a candidate-build / dispatch check.
    // The waiter has no relation to the graph (DL-1 design (d)): the member
    // filter is a plain read of pool_member (no row lock, no lock-order edge).
    const queuedMemberIds = (
      await tx.capacityWaiter.findMany({
        where: { capacityId, state: "WAITING", poolMemberId: { not: null } },
        select: { poolMemberId: true },
        distinct: ["poolMemberId"],
      })
    ).flatMap((row) => (row.poolMemberId ? [row.poolMemberId] : []));
    const unroutableMembers = queuedMemberIds.length
      ? await tx.poolMember.findMany({
          where: {
            id: { in: queuedMemberIds },
            // Weight and pool-member health route PRIMARY (local) members
            // only: external members are ordered by publicOrder with weight 0
            // and use provider health, checked at dispatch.
            OR: [
              { routingStatus: { not: "ACTIVE" } },
              { tier: "PRIMARY", weight: { lte: 0 } },
              { tier: "PRIMARY", healthStatus: "UNHEALTHY", nextRetryAt: { gt: now } },
            ],
          },
          select: { id: true },
        })
      : [];
    if (unroutableMembers.length)
      await tx.capacityWaiter.updateMany({
        where: {
          capacityId,
          state: "WAITING",
          poolMemberId: { in: unroutableMembers.map((member) => member.id) },
        },
        data: {
          state: "CANCELLED",
          stateChangedAt: now,
          terminalReason: MEMBER_UNROUTABLE_REASON,
        },
      });
    // A graph row, read without a lock: the capacity fence the caller holds
    // excludes every writer of its policy. A deleted capacity admits nothing;
    // its waiters are orphans the capacity sweeper terminalizes.
    const capacity = await tx.inferenceCapacity.findUnique({
      where: { id: capacityId },
      select: { userId: true, hardConcurrencyLimit: true },
    });
    if (!capacity) return null;
    const activeLeases = await tx.capacityLease.findMany({
      where: { capacityId, state: "ACTIVE" },
      select: { executionTargetId: true, poolMemberId: true },
    });
    // Time filtering (candidate/request deadlines, the creating and last-chance
    // exceptions) is the planner's job, so it is decided in one place.
    const queuedWaiters = await tx.capacityWaiter.findMany({
      where: { capacityId, state: "WAITING", AdmissionRequest: { state: "WAITING" } },
      include: {
        AdmissionRequest: {
          select: { requestId: true, attemptId: true, enqueueSequence: true, deadlineAt: true },
        },
      },
    });
    // No foreign key keeps the graph behind a waiter (DL-1 design (d)): a
    // candidate whose target, member or pool was deleted, or whose target
    // moved to another capacity, is cancelled here instead of planned.
    const waiters = await this.#dropOrphanedWaiters(
      tx,
      capacityId,
      queuedWaiters,
      now,
      projections,
    );
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
    // ACTIVE lease counts of every concurrency scope some waiter is limited
    // by: one grouped query per scope kind (not one count per scope).
    const scopeKeys = new Map<string, { kind: "POOL" | "MEMBER" | "TARGET"; id: string }>();
    for (const waiter of waiters) {
      if (waiter.effectiveConcurrencyLimit === null) continue;
      scopeKeys.set(`${waiter.effectiveConcurrencyScope}:${waiter.effectiveConcurrencyScopeId}`, {
        kind:
          waiter.effectiveConcurrencyScope === "POOL"
            ? "POOL"
            : waiter.effectiveConcurrencyScope === "MEMBER"
              ? "MEMBER"
              : "TARGET",
        id: waiter.effectiveConcurrencyScopeId,
      });
    }
    const scopeActive = new Map<string, number>();
    for (const [kind, column] of [
      ["POOL", "poolId"],
      ["MEMBER", "poolMemberId"],
      ["TARGET", "executionTargetId"],
    ] as const) {
      const ids = [
        ...new Set([...scopeKeys.values()].filter((scope) => scope.kind === kind).map((s) => s.id)),
      ];
      if (!ids.length) continue;
      const counted = await tx.capacityLease.groupBy({
        by: [column],
        where: { state: "ACTIVE", [column]: { in: ids } },
        _count: { _all: true },
      });
      const counts = new Map<string, number>();
      for (const row of counted) {
        const id = row[column];
        if (id) counts.set(id, row._count._all);
      }
      for (const [key, scope] of scopeKeys)
        if (scope.kind === kind) scopeActive.set(key, counts.get(scope.id) ?? 0);
    }

    const rows = new Map<string, AdmissionWaiterRow>();
    const plannerWaiters: PlannerWaiter[] = waiters.map((waiter) => {
      rows.set(waiter.id, {
        userId: waiter.userId,
        requestId: waiter.AdmissionRequest.requestId,
        attemptId: waiter.AdmissionRequest.attemptId,
        admissionRequestId: waiter.admissionRequestId,
        executionTargetId: waiter.executionTargetId,
        poolId: waiter.poolId,
        poolMemberId: waiter.poolMemberId,
        priority: waiter.effectivePriority,
      });
      return {
        waiterId: waiter.id,
        admissionRequestId: waiter.admissionRequestId,
        candidateOrder: waiter.candidateOrder,
        enqueueSequence: waiter.AdmissionRequest.enqueueSequence,
        priority: waiter.effectivePriority,
        notBefore: waiter.notBefore,
        deadlineAt: waiter.deadlineAt,
        requestDeadlineAt: waiter.AdmissionRequest.deadlineAt,
        ownerKey: waiter.poolMemberId
          ? `member:${waiter.poolMemberId}`
          : `direct:${waiter.executionTargetId}`,
        memberLimit: waiter.effectiveConcurrencyLimit,
        scopeKey: `${waiter.effectiveConcurrencyScope}:${waiter.effectiveConcurrencyScopeId}`,
        borrowPolicy: waiter.effectiveBorrowPolicy === "NEVER" ? "NEVER" : "WHEN_IDLE",
        leaseScopeKeys: [
          ...(waiter.poolId ? [`POOL:${waiter.poolId}`] : []),
          ...(waiter.poolMemberId ? [`MEMBER:${waiter.poolMemberId}`] : []),
          `DIRECT_TARGET:${waiter.executionTargetId}`,
        ],
      };
    });
    // The scheduler state is H (capacity_runtime), created lazily under the
    // capacity fence; a pass with no waiter plans nothing and needs none.
    const runtime = waiters.length
      ? await this.#capacityRuntime(tx, capacityId, capacity.userId)
      : { schedulerCursor: 31, schedulerDeficits: null, schedulerVersion: SCHEDULER_VERSION };
    return {
      snapshot: {
        capacityLimit: capacity.hardConcurrencyLimit,
        active: activeLeases.length,
        activeByOwner,
        reservationsByOwner,
        scopeActive,
        waiters: plannerWaiters,
        scheduler: {
          cursor: runtime.schedulerCursor,
          deficits: schedulerDeficits(runtime.schedulerDeficits),
          version: runtime.schedulerVersion,
        },
      },
      rows,
      userId: capacity.userId,
    };
  }

  /**
   * WRITE phase: persists a plan in a few batched statements.
   *
   * Winners are serialized at their durable request rows (one sorted
   * `FOR UPDATE` statement, then a re-read): the unique attemptId lease
   * constraint is a final invariant, not the normal arbitration mechanism. A
   * winner that another admitter can also reach was already locked, in sorted
   * order, by lockCrossCapacityAdmissionRequests; any other winner's row is
   * reachable only through capacity locks this transaction holds. A winner
   * that is no longer WAITING (or already holds a lease) ends the persisted
   * prefix and reports `stale`, so the caller re-plans from a fresh read.
   *
   * Shutdown fence (G2n pass 5): release/reclamation run under the durable-
   * cleanup permit, so their operations keep flowing after the fence arms.
   * The durable admission sequence starts HERE (scheduler/fencing update,
   * lease inserts, WAITING to ADMITTED), so the fence is checked ONCE, right
   * before the first write: armed writes nothing; a batch that started is
   * committed durable state and completes.
   *
   * Nothing is carried across transaction attempts: every retry re-reads and
   * re-plans, and fencing tokens come from the capacity_runtime counter.
   */
  async #persistGrants(
    tx: Prisma.TransactionClient,
    capacityId: string,
    now: Date,
    rows: ReadonlyMap<string, AdmissionWaiterRow>,
    plan: GrantPlan,
    userId: string,
  ): Promise<{ persisted: PlannedGrant[]; stale: boolean }> {
    if (!plan.grants.length) return { persisted: [], stale: false };
    const requestIds = [...new Set(plan.grants.map((grant) => grant.admissionRequestId))].sort();
    await tx.$queryRaw`SELECT id FROM admission_request WHERE id = ANY(${requestIds}::text[]) ORDER BY id FOR UPDATE`;
    const current = await tx.admissionRequest.findMany({
      where: { id: { in: requestIds } },
      select: { id: true, state: true, Lease: { select: { id: true } } },
    });
    const writable = new Set(
      current.filter((request) => request.state === "WAITING" && !request.Lease).map((r) => r.id),
    );
    const firstStale = plan.grants.findIndex((grant) => !writable.has(grant.admissionRequestId));
    const persisted = firstStale === -1 ? plan.grants : plan.grants.slice(0, firstStale);
    const stale = firstStale !== -1;
    if (isDbShutdownFenceArmed()) return { persisted: [], stale: false };
    // Also true when the FIRST winner is stale (nothing persisted): re-plan.
    if (!persisted.length) return { persisted: [], stale };
    const last = persisted[persisted.length - 1]!;
    await this.#capacityRuntime(tx, capacityId, userId);
    const updatedRuntime = await tx.capacityRuntime.update({
      where: { capacityId },
      data: {
        schedulerCursor: last.schedulerAfter.cursor,
        schedulerDeficits: [...last.schedulerAfter.deficits],
        schedulerVersion: SCHEDULER_VERSION,
        nextFencingToken: { increment: persisted.length },
      },
    });
    const firstToken = updatedRuntime.nextFencingToken - BigInt(persisted.length);
    await tx.capacityLease.createMany({
      data: persisted.map((grant, index) => {
        const row = rows.get(grant.waiterId);
        if (!row) throw new Error("Planned grant has no waiter row.");
        return {
          userId: row.userId,
          requestId: row.requestId,
          attemptId: row.attemptId,
          admissionRequestId: row.admissionRequestId,
          capacityId,
          executionTargetId: row.executionTargetId,
          poolId: row.poolId,
          poolMemberId: row.poolMemberId,
          priority: row.priority,
          reservationClass: grant.reservationClass,
          borrowed: grant.borrowed,
          fencingToken: firstToken + BigInt(index),
          ownerServerInstance: this.serverInstance,
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + 30_000),
        };
      }),
    });
    const winnerRequestIds = persisted.map((grant) => grant.admissionRequestId);
    const winnerWaiterIds = persisted.map((grant) => grant.waiterId);
    await tx.admissionRequest.updateMany({
      where: { id: { in: winnerRequestIds } },
      data: { state: "ADMITTED" },
    });
    await tx.capacityWaiter.updateMany({
      where: {
        admissionRequestId: { in: winnerRequestIds },
        state: "WAITING",
        id: { notIn: winnerWaiterIds },
      },
      data: { state: "CANCELLED", stateChangedAt: now, terminalReason: "sibling_lost" },
    });
    await tx.capacityWaiter.updateMany({
      where: { id: { in: winnerWaiterIds } },
      data: { state: "ADMITTED", stateChangedAt: now, terminalReason: null },
    });
    return { persisted, stale };
  }

  /**
   * One admission pass on one capacity: read, plan, write. The ONE path to a
   * slot for acquire (offer mode: `requestId` given, stops once it is
   * granted) and for release/reclaim (fill mode). Returns whether `requestId`
   * was granted here.
   *
   * Offers every free slot: with S-A spill-over, waiters become eligible by
   * time passing (not a release event), so several eligible waiters can sit
   * on a capacity with more than one free slot. The planner grants them in
   * DRR order (older eligible waiters first, as a release-fill would) until
   * the request holds a lease, nothing more is grantable, or the capacity is
   * full; the loop is bounded by the queue size, never by a constant.
   * Same locks as before (L4 plus the L6 pre-lock): no new lock-order edge.
   */
  async #admitCapacity(
    tx: Prisma.TransactionClient,
    capacityId: string,
    now: Date,
    projections: RelayAdmissionProjection[],
    options: {
      requestId?: string;
      creatingRequestId?: string;
      lastChanceWaiterIds?: readonly string[];
    } = {},
  ): Promise<boolean> {
    // G2n: fill mode (release/reclaim) is NEW admission work; with the fence
    // armed it starts nothing (no sweeps, no snapshot, no row locks). Offer
    // mode belongs to acquire, which the fence rejects on its own.
    if (options.requestId === undefined && isDbShutdownFenceArmed()) return false;
    // A re-planned pass happens only when a winner turned out to be no longer
    // grantable at the write phase (unreachable under the held locks); every
    // such round consumes at least one waiter, so the queue size bounds it.
    for (let round = 0; ; round++) {
      const read = await this.#readAdmissionSnapshot(
        tx,
        capacityId,
        now,
        options.creatingRequestId,
        projections,
      );
      // A deleted capacity admits nothing; its waiters are orphans the
      // capacity sweeper terminalizes.
      if (!read) return false;
      const { snapshot, rows, userId } = read;
      const plan = planGrants(snapshot, now, options);
      const { persisted, stale } = await this.#persistGrants(
        tx,
        capacityId,
        now,
        rows,
        plan,
        userId,
      );
      const granted =
        options.requestId !== undefined &&
        persisted.some((grant) => grant.admissionRequestId === options.requestId);
      if (granted || !stale || round >= snapshot.waiters.length) return granted;
    }
  }

  /** Capacity fences plus the cross-capacity request locks, for transactions that run #admitCapacity. */
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
        if (result.count) await this.#admitCapacity(tx, lease.capacityId, now, projections);
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
          await this.#admitCapacity(tx, lease.capacityId, lockedNow, projections);
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
          await this.#admitCapacity(tx, capacityId, now, projections);
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

/** Upper bound of one spill-over delay; matches the S4 cache-holder wait cap. */
export const MAX_CANDIDATE_NOT_BEFORE_MS = 30_000;
/**
 * A deferred attempt's candidates stay eligible at least this long after the
 * spill instant, so a zero budget ("admit only if free at the spill instant")
 * is checked by at least one runtime poll (100 ms) instead of expiring at the
 * very instant it becomes eligible.
 */
export const DEFERRED_MIN_ELIGIBLE_WINDOW_MS = 250;

function boundedNotBeforeMs(candidate: { notBeforeMs?: number }): number {
  const value = candidate.notBeforeMs;
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(MAX_CANDIDATE_NOT_BEFORE_MS, Math.max(0, Math.floor(value)));
}

/**
 * Durable schedule of every candidate of a NEW attempt on the database clock
 * (`now` is the in-transaction clock_timestamp()). Process clocks never decide
 * a wait budget or a spill-over instant.
 *
 * - `notBefore` = now + notBeforeMs (null when not deferred), never later than
 *   the candidate's absolute upper bound.
 * - The spill instant is the latest notBefore of the attempt. Every wait
 *   budget counts from it, so an `:external` caller's shortened budget E ends
 *   at max(notBefore) + E and a deadline never precedes its notBefore.
 * - With an `anchor` (a retry round, see AdmissionAttempt.schedule) the same
 *   schedule is computed from the anchor attempt's enqueue instant, the spill
 *   instant is at least anchor + spillDelayMs, and instants already in the
 *   past are clamped to `now` (no deferral; deadline now = "admit only if
 *   free now"), so a retry never restarts or extends the original schedule.
 */
export function candidateSchedules<
  C extends { deadlineAt?: Date; waitBudgetMs?: number | null; notBeforeMs?: number },
>(
  candidates: readonly C[],
  attemptDeadlineAt: Date,
  now: Date,
  anchor?: { at: Date; spillDelayMs: number },
): Array<{ notBefore: Date | null; deadlineAt: Date }> {
  const base = anchor && anchor.at < now ? anchor.at : now;
  const scheduledNotBefores = candidates.map((candidate) => {
    const delayMs = boundedNotBeforeMs(candidate);
    if (delayMs === 0) return null;
    const upperBound = candidate.deadlineAt ?? attemptDeadlineAt;
    const notBefore = new Date(base.getTime() + delayMs);
    return notBefore < upperBound ? notBefore : upperBound;
  });
  const anchoredSpillMs = anchor
    ? base.getTime() + boundedNotBeforeMs({ notBeforeMs: anchor.spillDelayMs })
    : base.getTime();
  const spillAt = new Date(
    Math.max(anchoredSpillMs, ...scheduledNotBefores.map((notBefore) => notBefore?.getTime() ?? 0)),
  );
  return candidates.map((candidate, index) => {
    const scheduled = scheduledNotBefores[index] ?? null;
    const notBefore = scheduled && scheduled > now ? scheduled : null;
    let deadlineAt = candidateDeadlineAt(candidate, attemptDeadlineAt, base, spillAt);
    if (deadlineAt < now) {
      const upperBound = candidate.deadlineAt ?? attemptDeadlineAt;
      deadlineAt = upperBound < now ? upperBound : now;
    }
    return {
      notBefore,
      deadlineAt: notBefore && deadlineAt < notBefore ? notBefore : deadlineAt,
    };
  });
}

/**
 * Effective candidate deadline on the database clock (`now` is the in-
 * transaction clock_timestamp()). Process clocks never decide a wait budget.
 * `spillAt` (default `now`) is the attempt's latest notBefore; the budget
 * counts from it (see {@link candidateSchedules}).
 */
export function candidateDeadlineAt(
  candidate: { deadlineAt?: Date; waitBudgetMs?: number | null },
  attemptDeadlineAt: Date,
  now: Date,
  spillAt: Date = now,
): Date {
  const upperBound = candidate.deadlineAt ?? attemptDeadlineAt;
  if (candidate.waitBudgetMs === undefined || candidate.waitBudgetMs === null) return upperBound;
  const budgetMs = Number.isFinite(candidate.waitBudgetMs)
    ? Math.max(0, Math.floor(candidate.waitBudgetMs))
    : 0;
  const deferred = spillAt.getTime() > now.getTime();
  const relative = new Date(
    spillAt.getTime() + (deferred ? Math.max(budgetMs, DEFERRED_MIN_ELIGIBLE_WINDOW_MS) : budgetMs),
  );
  return relative < upperBound ? relative : upperBound;
}

/**
 * Request-level terminal reason once no candidate is live: `member_unroutable`
 * when a grant-time re-check removed a candidate, else `candidate_deadlines`.
 */
async function noLiveCandidateReason(
  tx: Prisma.TransactionClient,
  admissionRequestId: string,
): Promise<string> {
  const unroutable = await tx.capacityWaiter.count({
    where: { admissionRequestId, terminalReason: MEMBER_UNROUTABLE_REASON },
  });
  return unroutable > 0 ? MEMBER_UNROUTABLE_REASON : "candidate_deadlines";
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
