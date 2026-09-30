import { describe, expect, it } from "vitest";
import {
  type AdmissionSnapshot,
  type GrantPlan,
  type PlannerOptions,
  type PlannerWaiter,
  planGrants,
} from "./admission-planner.js";
import { referencePlanGrants } from "./admission-planner.reference.js";
import {
  PRIORITY_CLASS_COUNT,
  type SchedulerCandidate,
  type SchedulerState,
  scheduleWeightedDeficitRoundRobin,
} from "./scheduler.js";

const NOW = new Date("2026-01-01T00:00:10.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const freshScheduler = (): SchedulerState => ({
  cursor: 0,
  deficits: Array(PRIORITY_CLASS_COUNT).fill(0),
  version: 1,
});

let counter = 0;
/** A waiter of its own request unless `request` is given. Owner defaults to its own member. */
function waiter(id: string, overrides: Partial<PlannerWaiter> & { seq?: number } = {}) {
  const { seq, ...rest } = overrides;
  counter++;
  const ownerKey = rest.ownerKey ?? `member:${id}`;
  return {
    waiterId: id,
    admissionRequestId: `req-${id}`,
    candidateOrder: 0,
    enqueueSequence: BigInt(seq ?? counter),
    priority: 0,
    notBefore: null,
    deadlineAt: null,
    requestDeadlineAt: null,
    ownerKey,
    memberLimit: null,
    scopeKey: `MEMBER:${ownerKey.replace("member:", "")}`,
    borrowPolicy: "WHEN_IDLE",
    leaseScopeKeys: [`MEMBER:${ownerKey.replace("member:", "")}`],
    ...rest,
  } satisfies PlannerWaiter;
}

function snapshot(
  waiters: PlannerWaiter[],
  overrides: Partial<AdmissionSnapshot> = {},
): AdmissionSnapshot {
  return {
    capacityLimit: null,
    active: 0,
    activeByOwner: new Map(),
    reservationsByOwner: new Map(),
    scopeActive: new Map(),
    waiters,
    scheduler: freshScheduler(),
    ...overrides,
  };
}

const ids = (plan: GrantPlan) => plan.grants.map((grant) => grant.waiterId);

type Row = {
  name: string;
  snapshot: () => AdmissionSnapshot;
  options?: PlannerOptions;
  granted: string[];
  stoppedBy?: GrantPlan["stoppedBy"];
  borrowed?: string[];
};

const rows: Row[] = [
  {
    name: "DRR order across priorities, FIFO within a class",
    // cursor 0: class 0 first, then class 5 spends its quantum (6) before class 0 returns.
    snapshot: () =>
      snapshot([
        waiter("p0-old", { seq: 1, priority: 0 }),
        waiter("p0-new", { seq: 2, priority: 0 }),
        waiter("p5-old", { seq: 3, priority: 5 }),
        waiter("p5-new", { seq: 4, priority: 5 }),
      ]),
    granted: ["p0-old", "p5-old", "p5-new", "p0-new"],
    stoppedBy: "none",
  },
  {
    name: "equal priority is served by enqueue sequence, not array order",
    snapshot: () =>
      snapshot([
        waiter("late", { seq: 9 }),
        waiter("early", { seq: 2 }),
        waiter("mid", { seq: 5 }),
      ]),
    granted: ["early", "mid", "late"],
  },
  {
    name: "the only slot goes to the older waiter",
    snapshot: () =>
      snapshot([waiter("younger", { seq: 2 }), waiter("older", { seq: 1 })], {
        capacityLimit: 1,
      }),
    options: { requestId: "req-younger" },
    granted: ["older"],
    stoppedBy: "limit",
  },
  {
    name: "offer mode stops right after the requested request is granted",
    snapshot: () =>
      snapshot([waiter("a", { seq: 1 }), waiter("b", { seq: 2 }), waiter("c", { seq: 3 })]),
    options: { requestId: "req-b" },
    granted: ["a", "b"],
    stoppedBy: "requested",
  },
  {
    name: "physical limit with some active leases leaves exactly the free slots",
    snapshot: () =>
      snapshot([waiter("a", { seq: 1 }), waiter("b", { seq: 2 }), waiter("c", { seq: 3 })], {
        capacityLimit: 3,
        active: 1,
      }),
    granted: ["a", "b"],
    stoppedBy: "limit",
  },
  {
    name: "a full capacity grants nothing",
    snapshot: () => snapshot([waiter("a")], { capacityLimit: 2, active: 2 }),
    granted: [],
    stoppedBy: "limit",
  },
  {
    name: "sibling waiters of one request on the capacity are one grant",
    snapshot: () =>
      snapshot([
        waiter("s1", { seq: 1, admissionRequestId: "same", candidateOrder: 0 }),
        waiter("s2", { seq: 1, admissionRequestId: "same", candidateOrder: 1 }),
        waiter("s3", { seq: 1, admissionRequestId: "same", candidateOrder: 2 }),
        waiter("other", { seq: 2 }),
      ]),
    granted: ["s1", "other"],
    stoppedBy: "none",
  },
  {
    name: "member/scope limit: a saturated scope is skipped, the next scope is served",
    snapshot: () =>
      snapshot(
        [
          waiter("full", { seq: 1, memberLimit: 1, scopeKey: "MEMBER:x" }),
          waiter("free", { seq: 2, memberLimit: 1, scopeKey: "MEMBER:y" }),
        ],
        {
          scopeActive: new Map([
            ["MEMBER:x", 1],
            ["MEMBER:y", 0],
          ]),
        },
      ),
    granted: ["free"],
  },
  {
    name: "member/scope limit is consumed by each grant (two of three fit a limit of 2)",
    snapshot: () =>
      snapshot(
        [1, 2, 3].map((n) =>
          waiter(`m${n}`, {
            seq: n,
            memberLimit: 2,
            scopeKey: "POOL:p",
            leaseScopeKeys: ["POOL:p"],
          }),
        ),
        { scopeActive: new Map([["POOL:p", 0]]) },
      ),
    granted: ["m1", "m2"],
  },
  {
    name: "deferred waiters are not granted before notBefore and do not block others",
    snapshot: () =>
      snapshot([
        waiter("deferred", { seq: 1, notBefore: at(1) }),
        waiter("due", { seq: 2, notBefore: at(0) }),
        waiter("plain", { seq: 3 }),
      ]),
    granted: ["due", "plain"],
  },
  {
    name: "candidate deadline: an expired waiter is not granted; the creating request keeps a zero budget",
    snapshot: () =>
      snapshot([
        waiter("expired", { seq: 1, deadlineAt: at(-1) }),
        waiter("open", { seq: 2, deadlineAt: at(1) }),
        waiter("zero-budget", { seq: 3, deadlineAt: at(0) }),
        waiter("zero-not-creating", { seq: 4, deadlineAt: at(0) }),
      ]),
    options: { creatingRequestId: "req-zero-budget" },
    granted: ["open", "zero-budget"],
  },
  {
    name: "creating exception does not revive a waiter past its own deadline",
    snapshot: () => snapshot([waiter("past", { seq: 1, deadlineAt: at(-1) })]),
    options: { creatingRequestId: "req-past" },
    granted: [],
  },
  {
    name: "last chance: a listed waiter past its deadline is granted; an unlisted one is not",
    snapshot: () =>
      snapshot([
        waiter("owed", { seq: 1, deadlineAt: at(-5), notBefore: at(-10) }),
        waiter("late", { seq: 2, deadlineAt: at(-5), notBefore: at(-10) }),
      ]),
    options: { lastChanceWaiterIds: ["owed"] },
    granted: ["owed"],
  },
  {
    name: "the absolute request deadline still ends a waiter, last chance included",
    snapshot: () =>
      snapshot([
        waiter("owed", { seq: 1, deadlineAt: at(-5), requestDeadlineAt: at(-1) }),
        waiter("alive", { seq: 2, requestDeadlineAt: at(-1) }),
        waiter("creating", { seq: 3, requestDeadlineAt: at(-1) }),
      ]),
    options: { lastChanceWaiterIds: ["owed"], creatingRequestId: "req-creating" },
    granted: ["creating"],
  },
  {
    name: "reservations: a borrowing waiter with policy NEVER is blocked, WHEN_IDLE is granted as borrowed",
    snapshot: () =>
      snapshot(
        [
          waiter("never", { seq: 1, ownerKey: "member:b1", borrowPolicy: "NEVER" }),
          waiter("idle", { seq: 2, ownerKey: "member:b2", borrowPolicy: "WHEN_IDLE" }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b1", 1]]),
          reservationsByOwner: new Map([["member:owner", 1]]),
        },
      ),
    granted: ["idle"],
    borrowed: ["idle"],
    stoppedBy: "limit",
  },
  {
    name: "reservations: not borrowing while enough slots stay free for the reservation",
    snapshot: () =>
      snapshot([waiter("b", { seq: 1, ownerKey: "member:b", borrowPolicy: "NEVER" })], {
        capacityLimit: 2,
        active: 0,
        reservationsByOwner: new Map([["member:owner", 1]]),
      }),
    granted: ["b"],
    borrowed: [],
  },
  {
    name: "reservations: a higher-priority queued reservation owner blocks borrowing",
    snapshot: () =>
      snapshot(
        [
          waiter("borrower", {
            seq: 1,
            ownerKey: "member:b",
            priority: 1,
            borrowPolicy: "WHEN_IDLE",
          }),
          waiter("owner", { seq: 2, ownerKey: "member:owner", priority: 10 }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b", 1]]),
          reservationsByOwner: new Map([["member:owner", 1]]),
          // the scheduler would otherwise pick the borrower's class 1 first
          scheduler: { cursor: 1, deficits: Array(PRIORITY_CLASS_COUNT).fill(0), version: 1 },
        },
      ),
    granted: ["owner"],
    borrowed: [],
  },
  {
    name: "reservations: a deferred reservation owner does not block borrowing",
    snapshot: () =>
      snapshot(
        [
          waiter("borrower", { seq: 1, ownerKey: "member:b", priority: 1 }),
          waiter("owner", { seq: 2, ownerKey: "member:owner", priority: 10, notBefore: at(5) }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b", 1]]),
          reservationsByOwner: new Map([["member:owner", 1]]),
        },
      ),
    granted: ["borrower"],
    borrowed: ["borrower"],
  },
  {
    name: "reservations: an owner whose scope is saturated does not block borrowing",
    snapshot: () =>
      snapshot(
        [
          waiter("borrower", { seq: 1, ownerKey: "member:b", priority: 1 }),
          waiter("owner", {
            seq: 2,
            ownerKey: "member:owner",
            priority: 10,
            memberLimit: 1,
            scopeKey: "MEMBER:owner",
          }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b", 1]]),
          reservationsByOwner: new Map([["member:owner", 1]]),
          scopeActive: new Map([["MEMBER:owner", 1]]),
        },
      ),
    granted: ["borrower"],
    borrowed: ["borrower"],
  },
  {
    name: "reservations: a lower-priority queued owner does not block borrowing",
    snapshot: () =>
      snapshot(
        [
          waiter("borrower", { seq: 1, ownerKey: "member:b", priority: 5 }),
          waiter("owner", { seq: 2, ownerKey: "member:owner", priority: 1 }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b", 1]]),
          reservationsByOwner: new Map([["member:owner", 1]]),
          scheduler: { cursor: 5, deficits: Array(PRIORITY_CLASS_COUNT).fill(0), version: 1 },
        },
      ),
    granted: ["borrower"],
    borrowed: ["borrower"],
  },
  {
    name: "reservations: an owner's own queued waiter never blocks its own borrowing",
    snapshot: () =>
      snapshot(
        [
          waiter("mine-low", { seq: 1, ownerKey: "member:b", priority: 1 }),
          waiter("mine-high", { seq: 2, ownerKey: "member:b", priority: 10 }),
        ],
        {
          capacityLimit: 2,
          active: 1,
          activeByOwner: new Map([["member:b", 1]]),
          reservationsByOwner: new Map([
            ["member:owner", 1],
            ["member:b", 0],
          ]),
        },
      ),
    // both eligible and borrowing; DRR serves the lower class first from cursor 0
    granted: ["mine-low"],
    borrowed: ["mine-low"],
  },
  {
    name: "unlimited capacity: 100 eligible waiters are all granted (no constant cap)",
    snapshot: () =>
      snapshot(Array.from({ length: 100 }, (_, index) => waiter(`w${index}`, { seq: index + 1 }))),
    granted: Array.from({ length: 100 }, (_, index) => `w${index}`),
    stoppedBy: "none",
  },
  {
    name: "maxGrants seam caps the plan; the default has no cap",
    snapshot: () =>
      snapshot(Array.from({ length: 5 }, (_, index) => waiter(`w${index}`, { seq: index + 1 }))),
    options: { maxGrants: 2 },
    granted: ["w0", "w1"],
    stoppedBy: "maxGrants",
  },
];

describe("planGrants: table", () => {
  for (const row of rows)
    it(row.name, () => {
      const input = row.snapshot();
      const plan = planGrants(input, NOW, row.options);
      expect(ids(plan)).toEqual(row.granted);
      if (row.stoppedBy) expect(plan.stoppedBy).toBe(row.stoppedBy);
      if (row.borrowed)
        expect(
          plan.grants.filter((grant) => grant.borrowed).map((grant) => grant.waiterId),
        ).toEqual(row.borrowed);
    });
});

describe("planGrants: state and bounds", () => {
  it("does not mutate its input", () => {
    const input = snapshot([waiter("a", { seq: 1 }), waiter("b", { seq: 2 })], {
      capacityLimit: 5,
      activeByOwner: new Map([["member:a", 1]]),
      scopeActive: new Map([["MEMBER:a", 0]]),
    });
    const before = JSON.stringify(
      [input.activeByOwner, input.scopeActive, input.scheduler, input.active].map((value) =>
        value instanceof Map ? [...value] : value,
      ),
    );
    planGrants(input, NOW);
    expect(
      JSON.stringify(
        [input.activeByOwner, input.scopeActive, input.scheduler, input.active].map((value) =>
          value instanceof Map ? [...value] : value,
        ),
      ),
    ).toBe(before);
    expect(input.waiters).toHaveLength(2);
  });

  it("advances DRR state exactly like repeated scheduler calls, per grant and finally", () => {
    const waiters = [
      waiter("a", { seq: 1, priority: 0 }),
      waiter("b", { seq: 2, priority: 3 }),
      waiter("c", { seq: 3, priority: 3 }),
      waiter("d", { seq: 4, priority: 9 }),
    ];
    const plan = planGrants(snapshot(waiters), NOW);
    let state = freshScheduler();
    let remaining: SchedulerCandidate[] = waiters.map((entry) => ({
      admissionRequestId: entry.admissionRequestId,
      waiterId: entry.waiterId,
      candidateOrder: 0,
      priority: entry.priority,
      enqueueSequence: entry.enqueueSequence,
      eligible: true,
    }));
    for (const grant of plan.grants) {
      const decision = scheduleWeightedDeficitRoundRobin({ candidates: remaining, state });
      expect(decision.winner?.waiterId).toBe(grant.waiterId);
      expect(grant.schedulerAfter).toEqual(decision.state);
      state = decision.state;
      remaining = remaining.filter((candidate) => candidate.waiterId !== grant.waiterId);
    }
    expect(plan.scheduler).toEqual(state);
  });

  it("returns the input scheduler state when nothing is granted", () => {
    const input = snapshot([waiter("deferred", { notBefore: at(1) })], {
      scheduler: { cursor: 7, deficits: Array(PRIORITY_CLASS_COUNT).fill(2), version: 1 },
    });
    const plan = planGrants(input, NOW);
    expect(plan.grants).toEqual([]);
    expect(plan.scheduler).toEqual(input.scheduler);
  });

  it("does no more than (waiters + 1) steps: k waiters cost k grants, and the work stays near-linear per step", () => {
    const count = 400;
    const start = performance.now();
    const plan = planGrants(
      snapshot(
        Array.from({ length: count }, (_, index) =>
          waiter(`w${index}`, { seq: index + 1, priority: index % 4 }),
        ),
        { capacityLimit: 300 },
      ),
      NOW,
    );
    expect(plan.grants).toHaveLength(300);
    expect(plan.stoppedBy).toBe("limit");
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Equivalence with the previous single-step decision (the old #admitOne).
// ---------------------------------------------------------------------------

/**
 * A literal, unoptimized transcription of the decision the store made in one
 * `#admitOne` pass before the planner existed (eligibility + borrow checks +
 * one DRR pick), over the same snapshot shape.
 */
function oldDecision(
  input: AdmissionSnapshot,
  now: Date,
  options: PlannerOptions,
): { waiterId: string; borrowed: boolean; state: SchedulerState } | undefined {
  const creating = options.creatingRequestId;
  const lastChance = options.lastChanceWaiterIds ?? [];
  const limit = input.capacityLimit;
  if (limit !== null && input.active >= limit) return undefined;
  const waiters = input.waiters.filter((entry) => {
    const waiterOk =
      entry.deadlineAt === null ||
      entry.deadlineAt > now ||
      (creating !== undefined &&
        entry.admissionRequestId === creating &&
        entry.deadlineAt >= now) ||
      lastChance.includes(entry.waiterId);
    const requestOk =
      entry.requestDeadlineAt === null ||
      entry.requestDeadlineAt > now ||
      (creating !== undefined && entry.admissionRequestId === creating);
    return waiterOk && requestOk;
  });
  const grantable = (entry: PlannerWaiter) => !entry.notBefore || entry.notBefore <= now;
  const eligible: SchedulerCandidate[] = [];
  const borrowedBy = new Map<string, boolean>();
  for (const entry of waiters) {
    if (!grantable(entry)) continue;
    if (entry.memberLimit !== null && entry.memberLimit !== undefined) {
      if ((input.scopeActive.get(entry.scopeKey) ?? 0) >= entry.memberLimit) continue;
    }
    const ownerKey = entry.ownerKey;
    const reservedForOthers = Math.min(
      limit ?? Number.MAX_SAFE_INTEGER,
      [...input.reservationsByOwner.entries()]
        .filter(([owner]) => owner !== ownerKey)
        .reduce(
          (total, [owner, slots]) =>
            total + Math.max(0, slots - (input.activeByOwner.get(owner) ?? 0)),
          0,
        ),
    );
    const ownReservedRemaining = Math.max(
      0,
      (input.reservationsByOwner.get(ownerKey) ?? 0) - (input.activeByOwner.get(ownerKey) ?? 0),
    );
    const borrowed =
      limit !== null &&
      ownReservedRemaining === 0 &&
      reservedForOthers > 0 &&
      limit - input.active <= reservedForOthers;
    const queuedReservationOwnerNeedsSlot = waiters.some(
      (other) =>
        other.waiterId !== entry.waiterId &&
        grantable(other) &&
        other.priority > entry.priority &&
        other.ownerKey !== ownerKey &&
        (input.reservationsByOwner.get(other.ownerKey) ?? 0) >
          (input.activeByOwner.get(other.ownerKey) ?? 0) &&
        (other.memberLimit === null ||
          other.memberLimit === undefined ||
          (input.scopeActive.get(other.scopeKey) ?? 0) < other.memberLimit),
    );
    if (borrowed && queuedReservationOwnerNeedsSlot) continue;
    if (borrowed && entry.borrowPolicy === "NEVER") continue;
    eligible.push({
      admissionRequestId: entry.admissionRequestId,
      waiterId: entry.waiterId,
      candidateOrder: entry.candidateOrder,
      priority: entry.priority,
      enqueueSequence: entry.enqueueSequence,
      eligible: true,
    });
    borrowedBy.set(entry.waiterId, borrowed);
  }
  if (!eligible.length) return undefined;
  const decision = scheduleWeightedDeficitRoundRobin({
    candidates: eligible,
    state: input.scheduler,
  });
  if (!decision.winner) return undefined;
  return {
    waiterId: decision.winner.waiterId,
    borrowed: borrowedBy.get(decision.winner.waiterId) ?? false,
    state: decision.state,
  };
}

/** Deterministic PRNG so failures reproduce. */
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function randomSnapshot(seed: number): { input: AdmissionSnapshot; options: PlannerOptions } {
  const random = prng(seed);
  const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
  const owners = ["member:o1", "member:o2", "member:o3", "direct:t1"];
  const count = 1 + Math.floor(random() * 14);
  const requests = Array.from({ length: Math.max(1, Math.floor(count * 0.7)) }, (_, i) => `r${i}`);
  const waiters = Array.from({ length: count }, (_, index) => {
    const owner = pick(owners);
    const limited = random() < 0.3;
    return waiter(`w${index}`, {
      seq: 1 + Math.floor(random() * 8),
      admissionRequestId: pick(requests),
      candidateOrder: Math.floor(random() * 3),
      priority: pick([0, 1, 5, 10, 31]),
      ownerKey: owner,
      notBefore: random() < 0.2 ? at(pick([-5, 0, 5])) : null,
      deadlineAt: random() < 0.25 ? at(pick([-5, 0, 5])) : null,
      requestDeadlineAt: random() < 0.1 ? at(pick([-5, 0, 5])) : null,
      memberLimit: limited ? pick([1, 2]) : null,
      scopeKey: `POOL:${pick(["pa", "pb"])}`,
      borrowPolicy: pick(["NEVER", "WHEN_IDLE"] as const),
      leaseScopeKeys: [`POOL:${pick(["pa", "pb"])}`],
    });
  });
  // The lease scope of a grant is the waiter's own pool.
  for (const entry of waiters) (entry.leaseScopeKeys as string[])[0] = entry.scopeKey;
  const capacityLimit = random() < 0.25 ? null : 1 + Math.floor(random() * 6);
  const activeByOwner = new Map(
    owners.filter(() => random() < 0.5).map((o) => [o, 1 + Math.floor(random() * 2)]),
  );
  const active = [...activeByOwner.values()].reduce((sum, n) => sum + n, 0);
  const deficits = Array.from({ length: PRIORITY_CLASS_COUNT }, () => Math.floor(random() * 3));
  return {
    input: snapshot(waiters, {
      capacityLimit,
      active,
      activeByOwner,
      reservationsByOwner: new Map(
        owners.filter(() => random() < 0.5).map((o) => [o, 1 + Math.floor(random() * 3)]),
      ),
      scopeActive: new Map([
        ["POOL:pa", Math.floor(random() * 3)],
        ["POOL:pb", Math.floor(random() * 3)],
      ]),
      scheduler: { cursor: Math.floor(random() * PRIORITY_CLASS_COUNT), deficits, version: 1 },
    }),
    options: {
      creatingRequestId: random() < 0.3 ? pick(requests) : undefined,
      lastChanceWaiterIds: random() < 0.3 ? [pick(waiters).waiterId] : [],
    },
  };
}

/** The old logic applied repeatedly with the documented in-memory updates. */
function naivePlan(input: AdmissionSnapshot, options: PlannerOptions) {
  let current = input;
  const granted: string[] = [];
  for (let step = 0; step <= input.waiters.length; step++) {
    const decision = oldDecision(current, NOW, options);
    if (!decision) break;
    const winner = current.waiters.find((entry) => entry.waiterId === decision.waiterId)!;
    granted.push(decision.waiterId);
    const activeByOwner = new Map(current.activeByOwner);
    activeByOwner.set(winner.ownerKey, (activeByOwner.get(winner.ownerKey) ?? 0) + 1);
    const scopeActive = new Map(current.scopeActive);
    for (const key of winner.leaseScopeKeys)
      if (scopeActive.has(key)) scopeActive.set(key, (scopeActive.get(key) ?? 0) + 1);
    current = {
      ...current,
      active: current.active + 1,
      activeByOwner,
      scopeActive,
      scheduler: decision.state,
      waiters: current.waiters.filter(
        (entry) => entry.admissionRequestId !== winner.admissionRequestId,
      ),
    };
  }
  return granted;
}

describe("planGrants: equivalence with the previous single-step decision", () => {
  it("the first grant equals the old #admitOne decision (borrowed flag and DRR state too), 600 random snapshots", () => {
    let decided = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const { input, options } = randomSnapshot(seed);
      const expected = oldDecision(input, NOW, options);
      const plan = planGrants(input, NOW, options);
      if (!expected) {
        expect(plan.grants, `seed ${seed}`).toEqual([]);
        continue;
      }
      decided++;
      expect(plan.grants[0]?.waiterId, `seed ${seed}`).toBe(expected.waiterId);
      expect(plan.grants[0]?.borrowed, `seed ${seed}`).toBe(expected.borrowed);
      expect(plan.grants[0]?.schedulerAfter, `seed ${seed}`).toEqual(expected.state);
    }
    // The generator must actually exercise grants, or the check is vacuous.
    expect(decided).toBeGreaterThan(300);
  });

  it("the whole plan equals the old decision applied repeatedly with in-memory updates, 600 random snapshots", () => {
    let multi = 0;
    for (let seed = 1001; seed <= 1600; seed++) {
      const { input, options } = randomSnapshot(seed);
      const plan = planGrants(input, NOW, options);
      const expected = naivePlan(input, options);
      expect(ids(plan), `seed ${seed}`).toEqual(expected);
      if (expected.length > 1) multi++;
    }
    expect(multi).toBeGreaterThan(100);
  });
});

// Seeded scenarios exercise interactions, while the fixed rows above pin the
// named boundary cases independently of the frozen implementation.
describe("indexed planner matches the frozen bc0c677 planner", () => {
  it.each(rows)("reference: $name", (row) => {
    const input = row.snapshot();
    expect(planGrants(input, NOW, row.options)).toEqual(
      referencePlanGrants(input, NOW, row.options),
    );
  });

  it("preserves all 32 classes with a nonzero cursor and carried deficits", () => {
    const input = snapshot(
      Array.from({ length: 96 }, (_, i) =>
        waiter(`all-${i}`, {
          seq: 96 - i,
          priority: i % 32,
        }),
      ),
      {
        scheduler: {
          cursor: 19,
          deficits: Array.from({ length: 32 }, (_, i) => i % 7),
          version: 1,
        },
      },
    );
    expect(planGrants(input, NOW)).toEqual(referencePlanGrants(input, NOW));
  });

  it("revisits a borrower blocked by a needy owner after that owner's scope fills", () => {
    const input = snapshot(
      [
        waiter("borrower-a", { seq: 1, priority: 0, ownerKey: "member:b" }),
        waiter("borrower-b", { seq: 2, priority: 0, ownerKey: "member:b" }),
        waiter("needy", {
          seq: 3,
          priority: 31,
          ownerKey: "member:n",
          memberLimit: 1,
          scopeKey: "POOL:needy",
          leaseScopeKeys: ["POOL:needy"],
        }),
        waiter("needy-sibling", {
          seq: 3,
          priority: 31,
          ownerKey: "member:n",
          memberLimit: 1,
          scopeKey: "POOL:needy",
          leaseScopeKeys: ["POOL:needy"],
        }),
      ],
      {
        capacityLimit: 5,
        active: 2,
        reservationsByOwner: new Map([["member:n", 3]]),
        scopeActive: new Map([["POOL:needy", 0]]),
      },
    );
    const plan = planGrants(input, NOW);
    expect(ids(plan)).toEqual(["needy", "borrower-a", "borrower-b"]);
    expect(plan).toEqual(referencePlanGrants(input, NOW));
  });

  it("matches 400 seeded mixed scenarios including siblings and temporary borrow blocks", () => {
    let seed = 0x131139;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (n: number) => Math.floor(random() * n);
    const time = () => [null, at(-1), at(0), at(1)][pick(4)]!;
    for (let scenario = 0; scenario < 400; scenario++) {
      const owners = Array.from({ length: 1 + pick(12) }, (_, i) => `member:o${i}`);
      const scopes = Array.from({ length: 1 + pick(8) }, (_, i) => `POOL:s${i}`);
      const inputWaiters = Array.from({ length: 1 + pick(90) }, (_, i) => {
        const request = pick(25);
        const scopeKey = scopes[pick(scopes.length)]!;
        return waiter(`random-${i}`, {
          admissionRequestId: `r${request}`,
          candidateOrder: i,
          seq: request,
          ownerKey: owners[pick(owners.length)]!,
          scopeKey,
          leaseScopeKeys: [scopeKey],
          memberLimit: [null, undefined, 0, 1, 3, 8][pick(6)],
          priority: pick(32),
          borrowPolicy: pick(2) ? "NEVER" : "WHEN_IDLE",
          notBefore: time(),
          deadlineAt: time(),
          requestDeadlineAt: time(),
        });
      });
      const input = snapshot(inputWaiters, {
        capacityLimit: pick(4) === 0 ? null : pick(30),
        active: pick(8),
        activeByOwner: new Map(owners.map((owner) => [owner, pick(4)])),
        reservationsByOwner: new Map(owners.map((owner) => [owner, pick(6)])),
        scopeActive: new Map(scopes.map((scope) => [scope, pick(4)])),
        scheduler: {
          cursor: pick(32),
          deficits: Array.from({ length: 32 }, () => pick(9)),
          version: 1,
        },
      });
      const options: PlannerOptions = {
        requestId: pick(3) === 0 ? `r${pick(25)}` : undefined,
        creatingRequestId: pick(2) ? `r${pick(25)}` : undefined,
        lastChanceWaiterIds: inputWaiters.filter(() => pick(4) === 0).map((w) => w.waiterId),
        maxGrants: pick(3) === 0 ? pick(15) : undefined,
      };
      expect(planGrants(input, NOW, options), `scenario ${scenario}`).toEqual(
        referencePlanGrants(input, NOW, options),
      );
    }
  });
});

it.each([null, 2500])(
  "plans 5000 waiters with scope limit %s within a loose budget",
  (scopeLimit) => {
    const input = snapshot(
      Array.from({ length: 5000 }, (_, i) =>
        waiter(`load-${i}`, {
          seq: i,
          priority: i % 32,
          ownerKey: "member:load",
          scopeKey: "POOL:load",
          memberLimit: scopeLimit,
          leaseScopeKeys: ["POOL:load"],
        }),
      ),
      { scopeActive: new Map([["POOL:load", 0]]) },
    );
    let ownerReads = 0;
    for (const entry of input.waiters)
      Object.defineProperty(entry, "ownerKey", {
        get: () => {
          ownerReads++;
          return "member:load";
        },
      });
    const started = performance.now();
    const plan = planGrants(input, NOW);
    const elapsed = performance.now() - started;
    console.log(
      `[planner-volume] scope=${scopeLimit} ${plan.grants.length} grants: ${elapsed.toFixed(0)} ms`,
    );
    expect(plan.grants).toHaveLength(scopeLimit ?? 5000);
    expect(new Set(plan.grants.map((g) => g.admissionRequestId)).size).toBe(scopeLimit ?? 5000);
    expect(plan.stoppedBy).toBe("none");
    // Pin queue work independently of machine speed: a full rescan per
    // grant performs millions of owner lookups on this reservation-free queue.
    expect(ownerReads).toBeLessThan(500_000);
    // Measured below 500 ms on the shared runner; > 10x CI headroom.
    expect(elapsed).toBeLessThan(6000);
  },
  15_000,
);
