import { describe, expect, it } from "vitest";
import {
  capacityCandidateEligible,
  defaultPriorityQuanta,
  PRIORITY_CLASS_COUNT,
  SCHEDULER_VERSION,
  type SchedulerState,
  scheduleWeightedDeficitRoundRobin,
} from "./scheduler.js";
import { assertPriority } from "./types.js";

const emptyState = () => ({ cursor: 0, deficits: Array(PRIORITY_CLASS_COUNT).fill(0), version: 1 });

describe("durable capacity scheduler", () => {
  it("validates the fixed priority range and positive quanta", () => {
    expect(assertPriority(0)).toBe(0);
    expect(assertPriority(31)).toBe(31);
    expect(() => assertPriority(32)).toThrow(RangeError);
    expect(() =>
      scheduleWeightedDeficitRoundRobin({
        candidates: [],
        state: emptyState(),
        quanta: Array(PRIORITY_CLASS_COUNT).fill(0),
      }),
    ).toThrow("positive integer");
  });

  it("selects FIFO by durable sequence then request id within a class", () => {
    const result = scheduleWeightedDeficitRoundRobin({
      state: emptyState(),
      candidates: [
        {
          admissionRequestId: "b",
          waiterId: "b",
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
        {
          admissionRequestId: "a",
          waiterId: "a",
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
      ],
    });
    expect(result.winner?.admissionRequestId).toBe("a");
    expect(result.state.version).toBe(SCHEDULER_VERSION);
  });

  it("selects an exact waiter when one request has multiple same-capacity candidates", () => {
    const result = scheduleWeightedDeficitRoundRobin({
      state: emptyState(),
      candidates: [
        {
          admissionRequestId: "request",
          waiterId: "waiter-1",
          candidateOrder: 1,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
        {
          admissionRequestId: "request",
          waiterId: "waiter-0",
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
      ],
    });
    expect(result.winner).toMatchObject({ waiterId: "waiter-0", candidateOrder: 0 });
  });

  it("orders equal-sequence FIFO by request before candidate order", () => {
    const result = scheduleWeightedDeficitRoundRobin({
      state: emptyState(),
      candidates: [
        {
          admissionRequestId: "request-b",
          waiterId: "b-0",
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
        {
          admissionRequestId: "request-a",
          waiterId: "a-9",
          candidateOrder: 9,
          priority: 0,
          enqueueSequence: 1n,
          eligible: true,
        },
      ],
    });
    expect(result.winner).toMatchObject({ admissionRequestId: "request-a", waiterId: "a-9" });
  });

  it("resets empty-class credit and advances a durable cursor", () => {
    const state = emptyState();
    state.deficits[5] = 99;
    const result = scheduleWeightedDeficitRoundRobin({
      state,
      candidates: [
        {
          admissionRequestId: "p7",
          waiterId: "p7",
          candidateOrder: 0,
          priority: 7,
          enqueueSequence: 1n,
          eligible: true,
        },
      ],
    });
    expect(result.state.deficits[5]).toBe(0);
    expect(result.state.cursor).toBe(7);
  });

  it("gives every continuously eligible class service across repeated releases", () => {
    let state: SchedulerState = emptyState();
    const winners: number[] = [];
    for (let round = 0; round < PRIORITY_CLASS_COUNT * 2; round++) {
      const result = scheduleWeightedDeficitRoundRobin({
        state,
        candidates: [
          {
            admissionRequestId: `low-${round}`,
            waiterId: `low-${round}`,
            candidateOrder: 0,
            priority: 0,
            enqueueSequence: 0n,
            eligible: true,
          },
          {
            admissionRequestId: `high-${round}`,
            waiterId: `high-${round}`,
            candidateOrder: 0,
            priority: 31,
            enqueueSequence: 0n,
            eligible: true,
          },
        ],
      });
      state = result.state;
      if (result.winner) winners.push(result.winner.priority);
    }
    expect(winners).toContain(0);
    expect(winners).toContain(31);
    expect(defaultPriorityQuanta().every((quantum) => quantum > 0)).toBe(true);
  });

  it("enforces physical, member, and reserved borrowing constraints without preemption", () => {
    expect(
      capacityCandidateEligible({
        physicalLimit: 4,
        physicalActive: 4,
        memberLimit: 3,
        memberActive: 1,
        reservedSlots: 0,
        higherPriorityWaiting: false,
        borrowing: false,
      }),
    ).toBe(false);
    expect(
      capacityCandidateEligible({
        physicalLimit: 4,
        physicalActive: 2,
        memberLimit: 2,
        memberActive: 2,
        reservedSlots: 0,
        higherPriorityWaiting: false,
        borrowing: false,
      }),
    ).toBe(false);
    expect(
      capacityCandidateEligible({
        physicalLimit: 4,
        physicalActive: 2,
        memberActive: 0,
        reservedSlots: 2,
        higherPriorityWaiting: true,
        borrowing: true,
      }),
    ).toBe(false);
  });
});
