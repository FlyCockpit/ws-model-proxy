import { assertPriority } from "./types.js";

export const PRIORITY_CLASS_COUNT = 32;
export const SCHEDULER_VERSION = 1;

export type SchedulerCandidate = {
  admissionRequestId: string;
  waiterId: string;
  candidateOrder: number;
  priority: number;
  enqueueSequence: bigint;
  eligible: boolean;
};

export type SchedulerState = {
  cursor: number;
  deficits: readonly number[];
  version: number;
};

export type SchedulerDecision = {
  winner?: SchedulerCandidate;
  state: SchedulerState;
};

export function capacityCandidateEligible({
  physicalLimit,
  physicalActive,
  memberLimit,
  memberActive,
  reservedSlots,
  higherPriorityWaiting,
  borrowing,
}: {
  physicalLimit?: number;
  physicalActive: number;
  memberLimit?: number;
  memberActive: number;
  reservedSlots: number;
  higherPriorityWaiting: boolean;
  borrowing: boolean;
}): boolean {
  if (physicalLimit !== undefined && physicalActive >= physicalLimit) return false;
  if (memberLimit !== undefined && memberActive >= memberLimit) return false;
  if (higherPriorityWaiting && borrowing) return false;
  if (
    physicalLimit !== undefined &&
    reservedSlots > 0 &&
    !borrowing &&
    physicalActive >= Math.max(0, physicalLimit - reservedSlots)
  )
    return false;
  return true;
}

export function defaultPriorityQuanta(): number[] {
  return Array.from({ length: PRIORITY_CLASS_COUNT }, (_, priority) => 1 + priority);
}

export function scheduleWeightedDeficitRoundRobin({
  candidates,
  state,
  quanta = defaultPriorityQuanta(),
}: {
  candidates: readonly SchedulerCandidate[];
  state: SchedulerState;
  quanta?: readonly number[];
}): SchedulerDecision {
  validateScheduler(state, quanta);
  const queues = new Map<number, SchedulerCandidate[]>();
  for (const candidate of candidates) {
    assertPriority(candidate.priority);
    if (!candidate.eligible) continue;
    const queue = queues.get(candidate.priority) ?? [];
    queue.push(candidate);
    queues.set(candidate.priority, queue);
  }
  for (const queue of queues.values())
    queue.sort((a, b) =>
      a.enqueueSequence === b.enqueueSequence
        ? a.admissionRequestId.localeCompare(b.admissionRequestId) ||
          a.candidateOrder - b.candidateOrder ||
          a.waiterId.localeCompare(b.waiterId)
        : a.enqueueSequence < b.enqueueSequence
          ? -1
          : 1,
    );

  const deficits = [...state.deficits];
  for (let priority = 0; priority < PRIORITY_CLASS_COUNT; priority++)
    if (!queues.has(priority)) deficits[priority] = 0;

  for (let visited = 0; visited < PRIORITY_CLASS_COUNT; visited++) {
    const priority = (state.cursor + visited) % PRIORITY_CLASS_COUNT;
    const queue = queues.get(priority);
    if (!queue?.length) continue;
    deficits[priority] = Math.min(deficits[priority]! + quanta[priority]!, quanta[priority]! * 2);
    if (deficits[priority]! < 1) continue;
    deficits[priority]!--;
    return {
      winner: queue[0],
      state: {
        cursor: deficits[priority]! >= 1 ? priority : (priority + 1) % PRIORITY_CLASS_COUNT,
        deficits,
        version: SCHEDULER_VERSION,
      },
    };
  }
  return { state: { cursor: state.cursor, deficits, version: SCHEDULER_VERSION } };
}

function validateScheduler(state: SchedulerState, quanta: readonly number[]) {
  if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor >= PRIORITY_CLASS_COUNT)
    throw new RangeError("Scheduler cursor is invalid.");
  if (state.deficits.length !== PRIORITY_CLASS_COUNT || quanta.length !== PRIORITY_CLASS_COUNT)
    throw new RangeError("Scheduler arrays must contain 32 priority classes.");
  if (quanta.some((quantum) => !Number.isInteger(quantum) || quantum <= 0))
    throw new RangeError("Every scheduler quantum must be a positive integer.");
}
