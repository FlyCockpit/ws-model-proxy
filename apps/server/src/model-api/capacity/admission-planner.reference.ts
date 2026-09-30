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

// Frozen bc0c677 planner. Test oracle only; keep its algorithm unchanged.
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
