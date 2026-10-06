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
 *
 * Kept (reserved) slots are a guarantee: a waiter may take a slot another
 * owner keeps only while no owner with unmet kept slots has a grantable
 * waiter, whatever the classes, and only when its policy allows borrowing.
 * After each grant the in-memory state advances (active counts, per-owner and
 * per-scope counts, the winner's request leaves the queue, DRR state) and the
 * next step is planned. The store then persists every grant in bounded batched
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
  /**
   * Every concurrency ceiling the waiter is bound by, each counted against
   * the ACTIVE leases of its `<scope>:<scopeId>` key: the member's own cap
   * and the pool-wide cap, or the direct target's cap. Empty = none.
   */
  scopeLimits: readonly { key: string; limit: number }[];
  /** May take a slot another owner keeps, while that owner has no waiter. */
  borrowReserved: boolean;
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
  /** ACTIVE lease count per `<scope>:<scopeId>` of every waiter scope limit. */
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

/**
 * Waiter passes the deadline filter of one admission pass at `now`. The one
 * definition: the planner and the metric-FULL fail-open sibling check
 * (postgres-store) both use it, so "live candidate" means the same thing.
 */
export function inWindow(
  waiter: Pick<
    PlannerWaiter,
    "waiterId" | "admissionRequestId" | "deadlineAt" | "requestDeadlineAt"
  >,
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
  const entries: Entry[] = snapshot.waiters
    .filter(
      (waiter) =>
        inWindow(waiter, now, options.creatingRequestId, lastChance) &&
        (!waiter.notBefore || waiter.notBefore <= now),
    )
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
  const ownerActive = (owner: string) => activeByOwner.get(owner) ?? 0;
  const scopeHasRoom = (waiter: PlannerWaiter) =>
    waiter.scopeLimits.every(({ key, limit }) => (scopeActive.get(key) ?? 0) < limit);

  type Queue = { entries: Entry[]; head: number; next: number[] };
  const classes = new Map<number, Queue>();
  const ownerQueues = new Map<string, Queue>();
  const takenRequests = new Set<string>();
  const remaining = new Map<string, number>();
  let reservedRemainingTotal = 0;
  for (const [owner, reserved] of reservations) {
    const slots = Math.max(0, reserved - ownerActive(owner));
    if (slots > 0) remaining.set(owner, slots);
    reservedRemainingTotal += slots;
  }
  for (const entry of entries) {
    const priority = entry.waiter.priority;
    let queue = classes.get(priority);
    if (!queue) {
      queue = { entries: [], head: 0, next: [] };
      classes.set(priority, queue);
    }
    queue.entries.push(entry);
    queue.next.push(queue.entries.length);
    const owner = entry.waiter.ownerKey;
    if (!remaining.has(owner)) continue;
    let ownerQueue = ownerQueues.get(owner);
    if (!ownerQueue) {
      ownerQueue = { entries: [], head: 0, next: [] };
      ownerQueues.set(owner, ownerQueue);
    }
    ownerQueue.entries.push(entry);
    ownerQueue.next.push(ownerQueue.entries.length);
  }
  const dead = (entry: Entry) =>
    takenRequests.has(entry.waiter.admissionRequestId) || !scopeHasRoom(entry.waiter);
  const pruneHead = (queue: Queue) => {
    while (queue.head < queue.entries.length && dead(queue.entries[queue.head]!))
      queue.head = queue.next[queue.head]!;
  };

  // Sort/index once: O(W log W). Each step examines at most 3 class heads
  // and owners with unmet reservations; permanent skips amortize to O(W).
  // Borrow-blocked entries are temporary and may be scanned again per grant:
  // adversarial borrowing can still cost the number of such skips per step.
  // Every grant removes a request, so queue size bounds the number of steps.
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

    // Only reservation owners with unmet kept slots and a live waiter block
    // a borrower (the guarantee), whatever their class. Two such owners
    // suffice to answer for every borrower, including one that is itself an
    // owner.
    let needyOwners: string[] | undefined;
    const ownerWaitingBesides = (ownerKey: string): boolean => {
      if (needyOwners === undefined) {
        needyOwners = [];
        for (const owner of remaining.keys()) {
          const queue = ownerQueues.get(owner);
          if (!queue) continue;
          pruneHead(queue);
          if (!queue.entries[queue.head]) continue;
          needyOwners.push(owner);
          if (needyOwners.length === 2) break;
        }
      }
      return needyOwners.some((owner) => owner !== ownerKey);
    };

    const eligible: Entry[] = [];
    const borrowedByWaiter = new Map<string, boolean>();
    for (const queue of classes.values()) {
      pruneHead(queue);
      let previous: number | undefined;
      for (let index = queue.head; index < queue.entries.length; ) {
        const entry = queue.entries[index]!;
        const next = queue.next[index]!;
        if (dead(entry)) {
          // Unlink even behind a temporary borrow blocker, so permanent
          // skips stay amortized instead of being revisited on every grant.
          if (previous === undefined) queue.head = next;
          else queue.next[previous] = next;
          index = next;
          continue;
        }
        const waiter = entry.waiter;
        const ownerRemaining = remaining.get(waiter.ownerKey) ?? 0;
        const reservedForOthers = Math.min(
          limit ?? Number.MAX_SAFE_INTEGER,
          reservedRemainingTotal - ownerRemaining,
        );
        const borrowed =
          limit !== null &&
          ownerRemaining === 0 &&
          reservedForOthers > 0 &&
          limit - active <= reservedForOthers;
        if (borrowed && (!waiter.borrowReserved || ownerWaitingBesides(waiter.ownerKey))) {
          // Retain temporary blockers for a later step; only dead entries
          // can be unlinked from a class's FIFO list.
          previous = index;
          index = next;
          continue;
        }
        eligible.push(entry);
        borrowedByWaiter.set(waiter.waiterId, borrowed);
        // DRR only selects queue[0] of a class; later candidates cannot
        // affect either its winner or its deficit reset for empty classes.
        break;
      }
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
    const owner = winner.waiter.ownerKey;
    activeByOwner.set(owner, ownerActive(owner) + 1);
    const slots = remaining.get(owner) ?? 0;
    if (slots > 0) {
      reservedRemainingTotal--;
      if (slots === 1) remaining.delete(owner);
      else remaining.set(owner, slots - 1);
    }
    for (const key of winner.waiter.leaseScopeKeys)
      if (scopeActive.has(key)) scopeActive.set(key, (scopeActive.get(key) ?? 0) + 1);
    // The request is ADMITTED and its other waiters on this capacity are
    // cancelled (sibling_lost): it leaves the queue.
    takenRequests.add(winner.waiter.admissionRequestId);
    if (options.requestId !== undefined && winner.waiter.admissionRequestId === options.requestId) {
      stoppedBy = "requested";
      break;
    }
  }
  return { grants, scheduler, stoppedBy };
}
