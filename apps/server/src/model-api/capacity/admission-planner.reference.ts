import type {
  AdmissionSnapshot,
  GrantPlan,
  PlannedGrant,
  PlannerOptions,
  PlannerWaiter,
} from "./admission-planner.js";
import {
  compareSchedulerCandidates,
  type SchedulerCandidate,
  scheduleWeightedDeficitRoundRobin,
} from "./scheduler.js";

// The bc0c677 planner with the limits-redesign rules (several scope limits
// per waiter; kept slots are a guarantee). Test oracle only: a direct,
// unoptimized statement of the rules; keep it simple.
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

export function referencePlanGrants(
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
    waiter.scopeLimits.every(({ key, limit }) => (scopeActive.get(key) ?? 0) < limit);

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
    // Owners with unmet reservation and a grantable waiter whose scope has
    // room ("queued reservation owner needs a slot"): any one of them other
    // than the borrower's own owner blocks the borrower, whatever the class.
    const needyOwners = new Set<string>();
    for (const entry of entries) {
      if (!grantable(entry)) continue;
      const owner = entry.waiter.ownerKey;
      if ((reservations.get(owner) ?? 0) <= ownerActive(owner)) continue;
      if (!scopeHasRoom(entry.waiter)) continue;
      needyOwners.add(owner);
    }
    const ownerWaitingBesides = (ownerKey: string) =>
      [...needyOwners].some((owner) => owner !== ownerKey);

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
      if (borrowed && ownerWaitingBesides(waiter.ownerKey)) continue;
      if (borrowed && !waiter.borrowReserved) continue;
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
