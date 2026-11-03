import type { Prisma } from "@ws-model-proxy/db";
import { describe, expect, it, vi } from "vitest";
import {
  endedNeverSentOr,
  endSteps,
  isHeldStep,
  type NeedsPersonStep,
  stepNeedsPerson,
  stepNeedsPersonWhere,
  stepRuleNeed,
  syncNeedsOperator,
  writeOperatorNeed,
} from "./operator-need";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const NOW = new Date("2026-11-03T12:00:00.000Z");
const PAST = new Date("2026-11-03T11:00:00.000Z");
const FUTURE = new Date("2026-11-03T13:00:00.000Z");

type StepRow = NeedsPersonStep & {
  id: string;
  instanceId: string;
  phase: string;
  attempts: number;
  rank: number;
  errorCode: string | null;
};

type InstanceRow = {
  id: string;
  runGeneration: number;
  phase: string;
  operationId: string | null;
  needsOperator: "STEP" | "RESTART" | "MARK_STOPPED" | null;
  needsOperatorSince: Date | null;
};

/** The `where` shapes these helpers write, evaluated on a row (Prisma's semantics). */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR")
      return (condition as Record<string, unknown>[]).some((branch) => matches(row, branch));
    const value = row[key];
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      if ("in" in ops) return (ops.in as unknown[]).includes(value);
      if ("not" in ops) return ops.not === null ? value !== null : value !== ops.not;
      if ("lte" in ops)
        return value instanceof Date && value.getTime() <= (ops.lte as Date).getTime();
      throw new Error(`unsupported condition ${JSON.stringify(ops)}`);
    }
    return value === condition;
  });
}

function fakeTx(instances: InstanceRow[], steps: StepRow[]) {
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const tx = {
    runtimeInstance: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        instances.find((row) => row.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = instances.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        writes.push({ id: where.id, data });
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    },
    instanceStep: {
      count: async ({ where }: { where: Record<string, unknown> }) =>
        steps.filter((row) => matches(row, where)).length,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = steps.filter((row) => matches(row, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
      aggregate: async () => ({ _max: { generation: null } }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, writes };
}

function instance(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: "i1",
    runGeneration: 2,
    phase: "STARTING",
    operationId: null,
    needsOperator: null,
    needsOperatorSince: null,
    ...overrides,
  };
}

let nextStep = 0;
function step(overrides: Partial<StepRow> = {}): StepRow {
  nextStep += 1;
  return {
    id: `s${nextStep}`,
    instanceId: "i1",
    phase: "START",
    state: "PENDING",
    operatorHold: null,
    operatorAcceptedAt: null,
    deadline: null,
    generation: 2,
    attempts: 0,
    rank: 0,
    errorCode: null,
    ...overrides,
  };
}

describe("needs a person: the predicate and its SQL form agree", () => {
  const STATES = ["PENDING", "RUNNING", "AWAITING_OPERATOR", "SUCCEEDED", "FAILED", "CANCELLED"];
  const rows: StepRow[] = [];
  for (const state of STATES)
    for (const operatorHold of [null, "operator_node_full"])
      for (const operatorAcceptedAt of [null, PAST])
        for (const deadline of [null, PAST, NOW, FUTURE])
          for (const generation of [1, 2])
            rows.push(step({ state, operatorHold, operatorAcceptedAt, deadline, generation }));

  for (const options of [{}, { run: 2 }, { run: 1 }]) {
    it(`for ${JSON.stringify(options)}`, () => {
      const where = stepNeedsPersonWhere(NOW, options) as Record<string, unknown>;
      for (const row of rows)
        expect(stepNeedsPerson(row, NOW, options), JSON.stringify(row)).toBe(matches(row, where));
    });
  }

  it("counts screens and holds of the run only, and an overdue person's run of any run", () => {
    const run = { run: 2 };
    expect(stepNeedsPerson(step({ state: "AWAITING_OPERATOR", generation: 1 }), NOW, run)).toBe(
      false,
    );
    expect(stepNeedsPerson(step({ state: "AWAITING_OPERATOR" }), NOW, run)).toBe(true);
    expect(stepNeedsPerson(step({ operatorHold: "operator_node_full" }), NOW, run)).toBe(true);
    expect(stepNeedsPerson(step({ operatorHold: "operator_node_full", generation: 1 }), NOW)).toBe(
      true,
    );
    expect(
      stepNeedsPerson(
        step({ state: "RUNNING", operatorAcceptedAt: PAST, deadline: NOW, generation: 1 }),
        NOW,
        run,
      ),
    ).toBe(true);
    // A person's run still within its timeout does not need them.
    expect(
      stepNeedsPerson(step({ state: "RUNNING", operatorAcceptedAt: PAST, deadline: FUTURE }), NOW),
    ).toBe(false);
  });

  it("HELD is PENDING with a hold only", () => {
    expect(isHeldStep({ state: "PENDING", operatorHold: "operator_session_full" })).toBe(true);
    expect(isHeldStep({ state: "PENDING", operatorHold: null })).toBe(false);
    expect(isHeldStep({ state: "RUNNING", operatorHold: "operator_session_full" })).toBe(false);
  });
});

describe("stepRuleNeed", () => {
  it("raises and clears STEP, and keeps the stop and restart rules' needs", () => {
    expect(stepRuleNeed(null, true)).toBe("STEP");
    expect(stepRuleNeed(null, false)).toBeNull();
    expect(stepRuleNeed("STEP", false)).toBeNull();
    expect(stepRuleNeed("STEP", true)).toBe("STEP");
    for (const kept of ["MARK_STOPPED", "RESTART"] as const) {
      expect(stepRuleNeed(kept, true)).toBe(kept);
      expect(stepRuleNeed(kept, false)).toBe(kept);
    }
  });
});

describe("syncNeedsOperator", () => {
  it("raises STEP for a held step of the current run", async () => {
    const row = instance();
    const { tx } = fakeTx([row], [step({ operatorHold: "operator_capability_missing" })]);
    await syncNeedsOperator(tx, "i1", NOW);
    expect(row.needsOperator).toBe("STEP");
    expect(row.needsOperatorSince).toBe(NOW);
  });

  it("never raises it for an earlier run's screen", async () => {
    const row = instance();
    const { tx, writes } = fakeTx([row], [step({ state: "AWAITING_OPERATOR", generation: 1 })]);
    await syncNeedsOperator(tx, "i1", NOW);
    expect(row.needsOperator).toBeNull();
    expect(writes).toEqual([]);
  });

  it("raises it for an earlier run's person whose run is overdue", async () => {
    const row = instance();
    const { tx } = fakeTx(
      [row],
      [step({ state: "RUNNING", operatorAcceptedAt: PAST, deadline: PAST, generation: 1 })],
    );
    await syncNeedsOperator(tx, "i1", NOW);
    expect(row.needsOperator).toBe("STEP");
  });

  it("clears STEP once nothing waits, and keeps an unchanged need's since", async () => {
    const waiting = instance({ needsOperator: "STEP", needsOperatorSince: PAST });
    const held = step({ state: "AWAITING_OPERATOR" });
    const { tx, writes } = fakeTx([waiting], [held]);
    await syncNeedsOperator(tx, "i1", NOW);
    expect(waiting.needsOperatorSince).toBe(PAST);
    expect(writes).toEqual([]);
    held.state = "SUCCEEDED";
    await syncNeedsOperator(tx, "i1", NOW);
    expect(waiting.needsOperator).toBeNull();
    expect(waiting.needsOperatorSince).toBeNull();
  });

  it("leaves MARK_STOPPED and RESTART to their rules", async () => {
    for (const need of ["MARK_STOPPED", "RESTART"] as const) {
      const row = instance({ needsOperator: need, needsOperatorSince: PAST });
      const { tx, writes } = fakeTx([row], []);
      await syncNeedsOperator(tx, "i1", NOW);
      expect(row.needsOperator).toBe(need);
      expect(writes).toEqual([]);
    }
  });
});

describe("endSteps: the one terminal write of a step", () => {
  it("always clears the hold and brings the need up to date", async () => {
    const row = instance({ needsOperator: "STEP", needsOperatorSince: PAST });
    const held = step({ operatorHold: "operator_node_full", phase: "STOP" });
    const { tx } = fakeTx([row], [held]);
    const ended = await endSteps(tx, {
      instanceId: "i1",
      where: { phase: "STOP", state: "PENDING", attempts: 0 },
      data: { state: "CANCELLED" },
      now: NOW,
    });
    expect(ended).toBe(1);
    expect(held).toMatchObject({ state: "CANCELLED", operatorHold: null });
    // The router's cancel used to leave this STEP behind until the engine's next pass.
    expect(row.needsOperator).toBeNull();
  });

  it("only touches the named instance's steps", async () => {
    const row = instance();
    const other = step({ instanceId: "i2", operatorHold: "operator_node_full" });
    const { tx } = fakeTx([row], [other]);
    expect(
      await endSteps(tx, {
        instanceId: "i1",
        where: { state: "PENDING" },
        data: { state: "CANCELLED" },
        now: NOW,
      }),
    ).toBe(0);
    expect(other.state).toBe("PENDING");
  });

  it("leaves the need to a caller that recomputes it, and writes nothing when nothing ended", async () => {
    const row = instance({ needsOperator: "STEP", needsOperatorSince: PAST });
    const held = step({ operatorHold: "operator_node_full" });
    const { tx, writes } = fakeTx([row], [held]);
    await endSteps(tx, {
      instanceId: "i1",
      where: { state: "PENDING" },
      data: { state: "FAILED", errorCode: "stopped" },
      now: NOW,
      need: "caller",
    });
    expect(held).toMatchObject({ state: "FAILED", errorCode: "stopped", operatorHold: null });
    expect(writes).toEqual([]);
    expect(
      await endSteps(tx, {
        instanceId: "i1",
        where: { state: "PENDING" },
        data: { state: "CANCELLED" },
        now: NOW,
      }),
    ).toBe(0);
    expect(writes).toEqual([]);
  });

  it("a never-sent step is CANCELLED, a sent one FAILED with its code", () => {
    expect(endedNeverSentOr(0, "superseded")).toEqual({ state: "CANCELLED" });
    expect(endedNeverSentOr(2, "superseded")).toEqual({ state: "FAILED", errorCode: "superseded" });
  });
});

describe("writeOperatorNeed", () => {
  it("writes only a change, compared with the stored need when none is given", async () => {
    const row = instance({ needsOperator: "STEP", needsOperatorSince: PAST });
    const { tx, writes } = fakeTx([row], []);
    await writeOperatorNeed(tx, "i1", "STEP", NOW);
    expect(writes).toEqual([]);
    await writeOperatorNeed(tx, "i1", "MARK_STOPPED", NOW);
    expect(row).toMatchObject({ needsOperator: "MARK_STOPPED", needsOperatorSince: NOW });
    // A caller's stale copy is trusted as given.
    await writeOperatorNeed(tx, "i1", null, NOW, null);
    expect(row.needsOperator).toBe("MARK_STOPPED");
  });
});
