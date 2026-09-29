import {
  compareSchedulerCandidates,
  type SchedulerCandidate,
  type SchedulerState,
  scheduleWeightedDeficitRoundRobin,
} from "./scheduler.js";

/**
 * The ONE enforcement point for "who gets a free slot of a physical capacity".
 *
 * `planGrants` is pure: it takes one snapshot of a capacity (read under the
 * capacity's admission locks by the store) and applies the admission decision
 * repeatedly in memory. Every step is exactly the decision the store used to
 * make in one `#admitOne` pass: eligibility (`notBefore`, deadlines with the
 * creating-request and last-chance exceptions, member/scope limits, physical
 * limit, reservation borrowing), then one weighted deficit round robin pick.
 * After each grant the in-memory state advances (active counts, per-owner and
 * per-scope counts, the winner's request leaves the queue, DRR state) and the
 * next step is planned. The store then persists every grant in a few batched
 * statements. Acquire (offer mode) and release/reclaim (fill mode) both go
 * through this function, so the two cannot disagree about who is served.
 */

export type PlannerWaiter = {
  waiterId: string;
  admissionRequestId: string;
  candidateOrder: number;
  /** Durable FIFO position of the waiter's request. */
  enqueueSequence: bigint;
  priority: number;
  /** Waiter's spill-over instant (database clock); a waiter before it is not grantable. */
  notBefore: Date | null;
  /** Waiter's candidate deadline (null = none). */
  deadlineAt: Date | null;
  /** The waiter's request's absolute deadline (null = none). */
  requestDeadlineAt: Date | null;
  /** `member:<id>` or `direct:<targetId>`: the owner of reservation accounting. */
  ownerKey: string;
  /** Member/scope concurrency ceiling (null/undefined = none). */
  memberLimit: number | null | undefined;
  /** `<scope>:<scopeId>` counted against `memberLimit`. */
  scopeKey: string;
  borrowPolicy: "NEVER" | "WHEN_IDLE";
  /** Scope keys whose ACTIVE lease count grows by one when this waiter is granted. */
  leaseScopeKeys: readonly string[];
};

export type AdmissionSnapshot = {
  /** Physical limit (null = unlimited). */
  capacityLimit: number | null;
  /** ACTIVE leases on the capacity. */
  active: number;
  activeByOwner: ReadonlyMap<string, number>;
  /** Allocated reservation slots per owner (see allocateReservationSlots). */
  reservationsByOwner: ReadonlyMap<string, number>;
  /** ACTIVE lease count per `<scope>:<scopeId>` of every waiter with a limit. */
  scopeActive: ReadonlyMap<string, number>;
  /** WAITING waiters of WAITING requests, before any time filtering. */
  waiters: readonly PlannerWaiter[];
  scheduler: SchedulerState;
};

export type PlannerOptions = {
  /** Offer mode: stop right after this request is granted. */
  requestId?: string;
  /** The attempt created in this transaction: its zero-budget waiters are still eligible. */
  creatingRequestId?: string;
  /** The polling request's deferred waiters owed one check past their deadline. */
  lastChanceWaiterIds?: readonly string[];
  /** Test seam: stop after this many grants (default: no cap besides progress). */
  maxGrants?: number;
};

export type PlannedGrant = {
  waiterId: string;
  admissionRequestId: string;
  borrowed: boolean;
  reservationClass: number;
  /** Scheduler state right after this grant (persisted with the last written grant). */
  schedulerAfter: SchedulerState;
};

export type GrantPlan = {
  grants: PlannedGrant[];
  /** Scheduler state after the last grant (the input state when there is none). */
  scheduler: SchedulerState;
  stoppedBy: "requested" | "none" | "limit" | "maxGrants" | "progress";
};

type Entry = { waiter: PlannerWaiter; candidate: SchedulerCandidate };

/** Waiter passes the deadline filter of one admission pass at `now`. */
function inWindow(
  waiter: PlannerWaiter,
  now: Date,
  creatingRequestId: string | undefined,
  lastChance: ReadonlySet<string>,
): boolean {
  const creating =
    creatingRequestId !== undefined && waiter.admissionRequestId === creatingRequestId;
  const waiterOpen =
    waiter.deadlineAt === null ||
    waiter.deadlineAt > now ||
    (creating && waiter.deadlineAt >= now) ||
    lastChance.has(waiter.waiterId);
  // The request's absolute deadline still ends a waiter (last chance included).
  const requestOpen =
    waiter.requestDeadlineAt === null || waiter.requestDeadlineAt > now || creating;
  return waiterOpen && requestOpen;
}

export function planGrants(
  snapshot: AdmissionSnapshot,
  now: Date,
  options: PlannerOptions = {},
): GrantPlan {
  const lastChance = new Set(options.lastChanceWaiterIds ?? []);
  // Sorted once; the DRR scheduler's own sort then sees presorted input.
  let entries: Entry[] = snapshot.waiters
    .filter((waiter) => inWindow(waiter, now, options.creatingRequestId, lastChance))
    .map((waiter) => ({
      waiter,
      candidate: {
        admissionRequestId: waiter.admissionRequestId,
        waiterId: waiter.waiterId,
        candidateOrder: waiter.candidateOrder,
        priority: waiter.priority,
        enqueueSequence: waiter.enqueueSequence,
        eligible: true,
      },
    }))
    .sort((a, b) => compareSchedulerCandidates(a.candidate, b.candidate));

  const limit = snapshot.capacityLimit;
  let active = snapshot.active;
  const activeByOwner = new Map(snapshot.activeByOwner);
  const scopeActive = new Map(snapshot.scopeActive);
  const reservations = snapshot.reservationsByOwner;
  let scheduler = snapshot.scheduler;
  const grants: PlannedGrant[] = [];
  const grantable = (entry: Entry) => !entry.waiter.notBefore || entry.waiter.notBefore <= now;
  const ownerActive = (owner: string) => activeByOwner.get(owner) ?? 0;
  const scopeHasRoom = (waiter: PlannerWaiter) =>
    waiter.memberLimit === null ||
    waiter.memberLimit === undefined ||
    (scopeActive.get(waiter.scopeKey) ?? 0) < waiter.memberLimit;

  // Every grant removes at least one waiter from the queue, so the queue size
  // plus one final "nothing more" pass bounds the work; there is no constant.
  const maxSteps = snapshot.waiters.length + 1;
  const maxGrants = options.maxGrants ?? Number.POSITIVE_INFINITY;
  let stoppedBy: GrantPlan["stoppedBy"] = "progress";
  for (let step = 0; step < maxSteps; step++) {
    if (grants.length >= maxGrants) {
      stoppedBy = "maxGrants";
      break;
    }
    if (limit !== null && active >= limit) {
      stoppedBy = "limit";
      break;
    }
    if (!entries.length) {
      stoppedBy = "none";
      break;
    }

    // Aggregates of this step (each O(W) once, then O(1) per waiter).
    let reservedRemainingTotal = 0;
    const remaining = (owner: string) =>
      Math.max(0, (reservations.get(owner) ?? 0) - ownerActive(owner));
    for (const owner of reservations.keys()) reservedRemainingTotal += remaining(owner);
    // Best priority of a grantable waiter whose owner still has unmet
    // reservation and whose scope has room ("queued reservation owner needs a
    // slot"), for the best owner and the best among all other owners.
    let needy: { priority: number; owner: string; otherPriority: number } | null | undefined;
    const needyFor = (ownerKey: string): number => {
      if (needy === undefined) {
        const byOwner = new Map<string, number>();
        for (const entry of entries) {
          if (!grantable(entry)) continue;
          const owner = entry.waiter.ownerKey;
          if ((reservations.get(owner) ?? 0) <= ownerActive(owner)) continue;
          if (!scopeHasRoom(entry.waiter)) continue;
          byOwner.set(owner, Math.max(byOwner.get(owner) ?? -1, entry.waiter.priority));
        }
        let best: [string, number] | undefined;
        for (const pair of byOwner) if (!best || pair[1] > best[1]) best = pair;
        if (!best) needy = null;
        else {
          let other = -1;
          for (const [owner, priority] of byOwner)
            if (owner !== best[0]) other = Math.max(other, priority);
          needy = { priority: best[1], owner: best[0], otherPriority: other };
        }
      }
      if (needy === null) return -1;
      return needy.owner === ownerKey ? needy.otherPriority : needy.priority;
    };

    const eligible: Entry[] = [];
    const borrowedByWaiter = new Map<string, boolean>();
    for (const entry of entries) {
      const waiter = entry.waiter;
      if (!grantable(entry)) continue;
      if (!scopeHasRoom(waiter)) continue;
      const reservedForOthers = Math.min(
        limit ?? Number.MAX_SAFE_INTEGER,
        reservedRemainingTotal - remaining(waiter.ownerKey),
      );
      const borrowed =
        limit !== null &&
        remaining(waiter.ownerKey) === 0 &&
        reservedForOthers > 0 &&
        limit - active <= reservedForOthers;
      if (borrowed && needyFor(waiter.ownerKey) > waiter.priority) continue;
      if (borrowed && waiter.borrowPolicy === "NEVER") continue;
      eligible.push(entry);
      borrowedByWaiter.set(waiter.waiterId, borrowed);
    }
    if (!eligible.length) {
      stoppedBy = "none";
      break;
    }
    const decision = scheduleWeightedDeficitRoundRobin({
      candidates: eligible.map((entry) => entry.candidate),
      state: scheduler,
    });
    const winner = decision.winner
      ? eligible.find((entry) => entry.candidate === decision.winner)
      : undefined;
    if (!winner) {
      stoppedBy = "none";
      break;
    }

    scheduler = decision.state;
    grants.push({
      waiterId: winner.waiter.waiterId,
      admissionRequestId: winner.waiter.admissionRequestId,
      borrowed: borrowedByWaiter.get(winner.waiter.waiterId) ?? false,
      reservationClass: winner.waiter.priority,
      schedulerAfter: decision.state,
    });
    // Apply the grant to the in-memory state.
    active++;
    activeByOwner.set(winner.waiter.ownerKey, ownerActive(winner.waiter.ownerKey) + 1);
    for (const key of winner.waiter.leaseScopeKeys)
      if (scopeActive.has(key)) scopeActive.set(key, (scopeActive.get(key) ?? 0) + 1);
    // The request is ADMITTED and its other waiters on this capacity are
    // cancelled (sibling_lost): it leaves the queue.
    entries = entries.filter(
      (entry) => entry.waiter.admissionRequestId !== winner.waiter.admissionRequestId,
    );
    if (options.requestId !== undefined && winner.waiter.admissionRequestId === options.requestId) {
      stoppedBy = "requested";
      break;
    }
  }
  return { grants, scheduler, stoppedBy };
}
