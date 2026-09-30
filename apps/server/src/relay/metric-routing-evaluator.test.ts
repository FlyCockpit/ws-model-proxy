import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

import {
  createRoutingEvaluationState,
  MetricRoutingEvaluator,
  ROUTING_EVALUATION_MIN_INTERVAL_MS,
  VERDICT_REFRESH_MS,
} from "./metric-routing-evaluator.js";

const T0 = new Date("2026-09-28T12:00:00.000Z");

function member(
  id: string,
  rules: unknown,
  endpointSlug = "gpu",
): {
  id: string;
  poolId: string;
  engineLoadMode: "AUTO" | "OFF";
  kvFullThreshold: number | null;
  ModelPool: { routingRules: unknown };
  DiscoveredModel: null;
  ExecutionTarget: {
    InferenceCapacity: { engineKind: string; engineSlots: number | null } | null;
    DiscoveredModel: { slug: string | null; Endpoint: { slug: string } };
  };
} {
  return {
    id,
    poolId: `pool-of-${id}`,
    engineLoadMode: "AUTO",
    kvFullThreshold: null,
    ModelPool: { routingRules: rules },
    DiscoveredModel: null,
    ExecutionTarget: {
      InferenceCapacity: null,
      DiscoveredModel: { slug: null, Endpoint: { slug: endpointSlug } },
    },
  };
}

/** A member on a vLLM (or other) engine, with no pool rules. */
function engineMember(
  id: string,
  engineKind: string,
  extra: Partial<ReturnType<typeof member>> = {},
  engineSlots: number | null = null,
  endpointSlug = "gpu",
) {
  const base = member(id, [], endpointSlug);
  return {
    ...base,
    ...extra,
    ExecutionTarget: {
      ...base.ExecutionTarget,
      InferenceCapacity: { engineKind, engineSlots },
    },
  };
}

function load(
  overrides: Partial<{
    endpointSlug: string;
    waiting: number;
    waitingStreak: number;
    kvUsage: number;
    slotsBusy: number;
    deferred: number;
    receivedAt: Date;
  }> = {},
) {
  return {
    endpointSlug: "gpu",
    modelSlug: null,
    running: 2,
    waiting: 0,
    waitingStreak: 0,
    receivedAt: T0,
    ...overrides,
  };
}

const hotRule = [{ metric: "node.gpu.temperature_c", op: ">", threshold: 80, effect: "full" }];
const busyRule = [{ metric: "endpoint.waiting", op: ">=", threshold: 2, effect: "avoid" }];

type Row = {
  poolMemberId: string;
  publisherId: string;
  verdict: string;
  ruleStates: string[];
  engineState?: string;
  evaluatedAt: Date;
  expiresAt: Date;
  poolId: string;
};

/**
 * An in-memory stand-in for the verdict table with the two operations the
 * evaluator uses: a conditional `updateMany` (by `evaluatedAt`) and a
 * `create` that fails like a unique violation (P2002) when the row exists.
 */
function harness(members: ReturnType<typeof member>[]) {
  let now = T0;
  const rows = new Map<string, Row>();
  const written: Row[] = [];
  const pools = new Map<string, unknown>(
    members.map((entry) => [entry.poolId, entry.ModelPool.routingRules]),
  );
  const db = {
    poolMember: {
      // The retraction re-read filters by id; the evaluation read does not.
      findMany: vi.fn(async (args?: { where?: { id?: { in: string[] } } }) =>
        args?.where?.id
          ? members.filter((entry) => args.where?.id?.in.includes(entry.id))
          : members,
      ),
    },
    modelPool: {
      findMany: vi.fn(async () =>
        [...pools.entries()].map(([id, routingRules]) => ({ id, routingRules })),
      ),
    },
    poolMemberRoutingVerdict: {
      updateMany: vi.fn(
        async (args: {
          where: {
            poolMemberId: string;
            OR: [{ evaluatedAt: { lt: Date } }, { evaluatedAt: Date; publisherId: string }];
          };
          data: Omit<Row, "poolMemberId">;
        }) => {
          const row = rows.get(args.where.poolMemberId);
          if (!row) return { count: 0 };
          const [strictlyOlder, samePublisher] = args.where.OR;
          const replaceable =
            row.evaluatedAt < strictlyOlder.evaluatedAt.lt ||
            (row.evaluatedAt.getTime() === samePublisher.evaluatedAt.getTime() &&
              row.publisherId === samePublisher.publisherId);
          if (!replaceable) return { count: 0 };
          rows.set(row.poolMemberId, { ...row, ...args.data });
          written.push({ ...row, ...args.data });
          return { count: 1 };
        },
      ),
      create: vi.fn(async (args: { data: Row }) => {
        if (rows.has(args.data.poolMemberId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        rows.set(args.data.poolMemberId, { ...args.data });
        written.push({ ...args.data });
        return {};
      }),
      deleteMany: vi.fn(
        async (args: {
          where: {
            poolId?: string;
            poolMemberId?: { in: string[] };
            evaluatedAt?: Date;
            publisherId?: string;
          };
        }) => {
          let count = 0;
          for (const [id, row] of [...rows]) {
            const matches =
              (args.where.poolId === undefined || row.poolId === args.where.poolId) &&
              (args.where.poolMemberId === undefined || args.where.poolMemberId.in.includes(id)) &&
              (args.where.evaluatedAt === undefined ||
                row.evaluatedAt.getTime() === args.where.evaluatedAt.getTime()) &&
              (args.where.publisherId === undefined || row.publisherId === args.where.publisherId);
            if (matches) {
              rows.delete(id);
              count += 1;
            }
          }
          return { count };
        },
      ),
    },
  };
  const evaluator = new MetricRoutingEvaluator(db as never, () => now);
  return {
    db,
    rows,
    written,
    /** Evaluation reads of the member list (the retraction re-read filters by id). */
    evaluations: () =>
      db.poolMember.findMany.mock.calls.filter(
        (call) => !(call as unknown as [{ where?: { id?: unknown } }?])[0]?.where?.id,
      ).length,
    evaluator,
    /** Replace a pool's rules, as `setPoolRoutingRules` does (rules, then clear its verdicts). */
    editRules: (poolId: string, rules: unknown) => {
      pools.set(poolId, rules);
      for (const [id, row] of rows) if (row.poolId === poolId) rows.delete(id);
    },
    setRulesWithoutClearing: (poolId: string, rules: unknown) => {
      pools.set(poolId, rules);
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

function metrics(temperature: number, receivedAt: Date) {
  return {
    nodeMetrics: {
      sample: { ts: receivedAt.toISOString(), gpus: [{ index: 0, temperatureC: temperature }] },
      receivedAt,
    },
    endpointLoad: [],
  };
}

describe("MetricRoutingEvaluator engine load (S-D)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every stored verdict write (a conditional update that hit, or a create), in order. */
  function writes(h: ReturnType<typeof harness>) {
    return h.written;
  }

  it("writes FULL for a rule-less vLLM member with sustained waiting, expiring with the reading", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [load({ waiting: 3, waitingStreak: 2 })],
    });
    expect(writes(h)).toEqual([
      expect.objectContaining({
        poolMemberId: "m1",
        verdict: "FULL",
        engineState: "full_waiting",
        expiresAt: new Date(T0.getTime() + 15_000),
      }),
    ]);
  });

  it("fences once for members without an engine signal, a single waiting frame or an idle engine", async () => {
    const h = harness([
      engineMember("ollama", "OLLAMA", {}, null, "a"),
      engineMember("generic", "GENERIC", {}, null, "b"),
      engineMember("once", "VLLM", {}, null, "c"),
      engineMember("idle", "SGLANG", {}, null, "d"),
    ]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [
        load({ endpointSlug: "a", waiting: 9, waitingStreak: 9, kvUsage: 1 }),
        load({ endpointSlug: "b", waiting: 9, waitingStreak: 9, kvUsage: 1 }),
        load({ endpointSlug: "c", waiting: 9, waitingStreak: 1 }),
        load({ endpointSlug: "d", kvUsage: 0.2 }),
      ],
    });
    expect(writes(h).map((row) => [row.poolMemberId, row.verdict])).toEqual([
      ["ollama", "NONE"],
      ["generic", "NONE"],
      ["once", "NONE"],
      ["idle", "NONE"],
    ]);
  });

  it("marks llama.cpp FULL on all slots busy or deferred requests", async () => {
    const h = harness([
      engineMember("busy", "LLAMA_CPP", {}, 2, "a"),
      engineMember("deferred", "LLAMA_CPP", {}, 4, "b"),
      engineMember("room", "LLAMA_CPP", {}, 4, "c"),
    ]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [
        load({ endpointSlug: "a", slotsBusy: 2 }),
        load({ endpointSlug: "b", slotsBusy: 1, deferred: 2 }),
        load({ endpointSlug: "c", slotsBusy: 3 }),
      ],
    });
    expect(writes(h).map((row) => [row.poolMemberId, row.verdict, row.engineState])).toEqual([
      ["busy", "FULL", "full_slots"],
      ["deferred", "FULL", "full_deferred"],
      ["room", "NONE", "clear"],
    ]);
  });

  it("ignores a stale reading and an 'off' override", async () => {
    const h = harness([
      engineMember("stale", "VLLM", {}, null, "a"),
      engineMember("off", "VLLM", { engineLoadMode: "OFF" }, null, "b"),
    ]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const hot = { waiting: 5, waitingStreak: 5, kvUsage: 1 };
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [
        load({ endpointSlug: "a", ...hot, receivedAt: new Date(T0.getTime() - 16_000) }),
        load({ endpointSlug: "b", ...hot }),
      ],
    });
    expect(writes(h).map((row) => [row.poolMemberId, row.verdict, row.engineState])).toEqual([
      ["stale", "NONE", "stale"],
      ["off", "NONE", "off"],
    ]);
  });

  it("honours a per-member KV threshold", async () => {
    const h = harness([engineMember("m1", "VLLM", { kvFullThreshold: 0.5 })]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.6 })],
    });
    expect(writes(h)[0]).toMatchObject({ verdict: "FULL", engineState: "full_kv" });
  });

  it("only adds to FULL: a triggered avoid rule becomes FULL, a FULL rule stays FULL with the later expiry", async () => {
    const avoidHot = [
      { metric: "node.gpu.temperature_c", op: ">", threshold: 80, effect: "avoid" },
    ];
    const base = engineMember("m1", "VLLM");
    const h = harness([{ ...base, ModelPool: { routingRules: avoidHot } }]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      ...metrics(90, T0),
      endpointLoad: [load({ waiting: 1, waitingStreak: 2 })],
    });
    expect(writes(h)[0]).toMatchObject({ verdict: "FULL", engineState: "full_waiting" });
    const h2 = harness([{ ...base, ModelPool: { routingRules: hotRule } }]);
    await h2.evaluator.evaluate(createRoutingEvaluationState("user-1", "device-1"), {
      ...metrics(90, T0),
      endpointLoad: [load({ waiting: 1, waitingStreak: 2 })],
    });
    // Rule expiry (90 s) is later than the engine's (15 s): the later one wins.
    expect(writes(h2)[0]).toMatchObject({
      verdict: "FULL",
      expiresAt: new Date(T0.getTime() + 90_000),
    });
  });

  it("a clear engine never relaxes a rule FULL", async () => {
    const base = engineMember("m1", "VLLM");
    const h = harness([{ ...base, ModelPool: { routingRules: hotRule } }]);
    await h.evaluator.evaluate(createRoutingEvaluationState("user-1", "device-1"), {
      ...metrics(90, T0),
      endpointLoad: [load({ kvUsage: 0.1 })],
    });
    expect(writes(h)[0]).toMatchObject({ verdict: "FULL", engineState: "clear" });
  });

  it("bounds writes: refresh at most every interval, one clearing write, then silence", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const hotLoad = () => load({ waiting: 2, waitingStreak: 3, receivedAt: h.now() });
    // 20 frames one second apart: only the first plus the 5 s refreshes write.
    for (let index = 0; index < 20; index += 1) {
      await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [hotLoad()] });
      h.advance(1_000);
    }
    expect(writes(h)).toHaveLength(4);
    // The engine calms down: one NONE write, then no more writes.
    for (let index = 0; index < 10; index += 1) {
      await h.evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [load({ receivedAt: h.now() })],
      });
      h.advance(1_000);
    }
    expect(writes(h)).toHaveLength(5);
    expect(writes(h).at(-1)).toMatchObject({ verdict: "NONE", engineState: "clear" });
  });

  it("rewrites at once when the reason changes although the verdict stays FULL", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [load({ waiting: 2, waitingStreak: 2 })],
    });
    h.advance(1_000);
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.99, receivedAt: h.now() })],
    });
    expect(writes(h).map((row) => row.engineState)).toEqual(["full_waiting", "full_kv"]);
  });

  it("clears a FULL row when the reading goes stale (fail open)", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const hotLoad = load({ waiting: 2, waitingStreak: 3 });
    await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [hotLoad] });
    h.advance(20_000);
    await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [hotLoad] });
    expect(writes(h).map((row) => [row.verdict, row.engineState])).toEqual([
      ["FULL", "full_waiting"],
      ["NONE", "stale"],
    ]);
  });
});

describe("MetricRoutingEvaluator successor fences", () => {
  it.each([false, true])(
    "sequential reconnect (with rules: %s) clears inherited FULL",
    async (withRules) => {
      const h = harness([
        engineMember("m1", "VLLM", { ModelPool: { routingRules: withRules ? hotRule : [] } }),
      ]);
      const a = createRoutingEvaluationState("user-1", "device-1");
      await h.evaluator.evaluate(a, { nodeMetrics: null, endpointLoad: [load({ kvUsage: 0.99 })] });
      expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL", engineState: "full_kv" });
      h.evaluator.cancel(a);
      h.advance(1_000);
      // A separate evaluator has no knowledge of A's local cache or epoch.
      const otherProcess = new MetricRoutingEvaluator(h.db as never, h.now);
      const b = createRoutingEvaluationState("user-1", "device-1");
      expect(b.probed.size).toBe(0);
      expect(b.probedEpoch).toBe(0);
      await otherProcess.evaluate(b, {
        nodeMetrics: null,
        endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
      });
      expect(h.rows.get("m1")).toMatchObject({
        verdict: "NONE",
        engineState: "clear",
        ruleStates: withRules ? ["stale"] : [],
        publisherId: b.publisherId,
        evaluatedAt: h.now(),
      });
      expect(b.probed.has("m1")).toBe(true);
    },
  );

  it.each([0, 1_000])(
    "delayed cancelled create (%s ms apart) loses to the successor fence",
    async (gap) => {
      const h = harness([engineMember("m1", "VLLM")]);
      const a = createRoutingEvaluationState("user-1", "device-1");
      const b = createRoutingEvaluationState("user-1", "device-1");
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
      h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
        entered();
        await gate;
        return create?.(args) ?? {};
      });
      const pending = h.evaluator.evaluate(a, {
        nodeMetrics: null,
        endpointLoad: [load({ kvUsage: 0.99 })],
      });
      try {
        await started;
        h.evaluator.cancel(a);
        expect(h.rows.size).toBe(0);
        h.advance(gap);
        const otherProcess = new MetricRoutingEvaluator(h.db as never, h.now);
        await otherProcess.evaluate(b, {
          nodeMetrics: null,
          endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
        });
        expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", publisherId: b.publisherId });
      } finally {
        release();
        await pending;
      }
      expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", publisherId: b.publisherId });
      expect(h.written).toHaveLength(1);
      expect(a.probed.size).toBe(0);
      expect(h.db.poolMemberRoutingVerdict.updateMany).toHaveBeenCalledTimes(3);
    },
  );

  it("successor create conflict retries after the older FULL wins creation", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const a = createRoutingEvaluationState("user-1", "device-1");
    const b = createRoutingEvaluationState("user-1", "device-1");
    h.advance(1_000);
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      h.advance(-1_000);
      await h.evaluator.evaluate(a, { nodeMetrics: null, endpointLoad: [load({ kvUsage: 0.99 })] });
      h.advance(1_000);
      return create?.(args) ?? {};
    });
    await h.evaluator.evaluate(b, {
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
    });
    expect(h.written.map((row) => row.verdict)).toEqual(["FULL", "NONE"]);
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", publisherId: b.publisherId });
  });

  it("failed successor publication is retried before marking the member probed", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    h.db.poolMemberRoutingVerdict.create.mockRejectedValueOnce(new Error("unavailable"));
    const inputs = { nodeMetrics: null, endpointLoad: [load({ kvUsage: 0.2 })] };
    await expect(h.evaluator.evaluate(state, inputs)).rejects.toThrow("unavailable");
    expect(state.probed.size).toBe(0);
    await h.evaluator.evaluate(state, inputs);
    expect(h.written).toHaveLength(1);
    expect(state.probed.has("m1")).toBe(true);
  });

  it.each([0.2, 0.99])(
    "successor write budget at KV %s survives refresh boundaries",
    async (kvUsage) => {
      const h = harness([engineMember("m1", "VLLM")]);
      const state = createRoutingEvaluationState("user-1", "device-1");
      for (let frame = 0; frame < 6; frame += 1) {
        await h.evaluator.evaluate(state, {
          nodeMetrics: null,
          endpointLoad: [load({ kvUsage, receivedAt: h.now() })],
        });
        expect(h.written).toHaveLength(kvUsage === 0.99 && frame === 5 ? 2 : 1);
        h.advance(1_000);
      }
      expect(state.probed.has("m1")).toBe(true);
      expect(state.written.has("m1")).toBe(kvUsage === 0.99);
      expect(h.db.poolMemberRoutingVerdict.updateMany).toHaveBeenCalledTimes(
        kvUsage === 0.99 ? 2 : 1,
      );
    },
  );

  it.each([false, true])(
    "override edit on another process rewrites unchanged FULL (with rules: %s)",
    async (withRules) => {
      const members = [
        engineMember("m1", "VLLM", {
          kvFullThreshold: 0.95,
          ModelPool: { routingRules: withRules ? hotRule : [] },
        }),
      ];
      const h = harness(members);
      const state = createRoutingEvaluationState("user-1", "device-1");
      await h.evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [load({ kvUsage: 0.97 })],
      });
      members[0]!.kvFullThreshold = 0.96;
      await new MetricRoutingEvaluator(h.db as never, h.now).clearPool("pool-of-m1");
      expect(h.rows.size).toBe(0);
      h.advance(1_000);
      await h.evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [load({ kvUsage: 0.97, receivedAt: h.now() })],
      });
      expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL", engineState: "full_kv" });
      expect(h.written).toHaveLength(2);
      h.advance(1_000);
      await h.evaluator.evaluate(state, {
        nodeMetrics: null,
        endpointLoad: [load({ kvUsage: 0.97, receivedAt: h.now() })],
      });
      expect(h.written).toHaveLength(2);
    },
  );

  it.each(["member leaves", "local clear"])("successor probe resets after %s", async (event) => {
    const members = [engineMember("m1", "VLLM")];
    const original = members[0]!;
    const h = harness(members);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const inputs = () => ({
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
    });
    await h.evaluator.evaluate(state, inputs());
    expect(h.written).toHaveLength(1);
    h.advance(1_000);
    if (event === "member leaves") {
      members.splice(0);
      await h.evaluator.evaluate(state, inputs());
      expect(state.probed.size).toBe(0);
      members.push(original);
    } else {
      await h.evaluator.clearPool("pool-of-m1");
    }
    await h.evaluator.evaluate(state, inputs());
    expect(h.written).toHaveLength(2);
    expect(state.probed.has("m1")).toBe(true);
    h.advance(1_000);
    await h.evaluator.evaluate(state, inputs());
    expect(h.written).toHaveLength(2);
  });

  it("an older calm successor cannot clear a newer FULL owner", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const newer = createRoutingEvaluationState("user-1", "device-1");
    h.advance(1_000);
    await h.evaluator.evaluate(newer, {
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.99, receivedAt: h.now() })],
    });
    h.advance(-1_000);
    const older = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(older, {
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.2 })],
    });
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL", publisherId: newer.publisherId });
    expect(older.probed.size).toBe(0);
  });

  it("a clear during publication invalidates the in-flight successor probe", async () => {
    const h = harness([engineMember("m1", "VLLM")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (create?.(args) ?? {});
      await h.evaluator.clearPool("pool-of-m1");
      return result;
    });
    const inputs = () => ({
      nodeMetrics: null,
      endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
    });
    await h.evaluator.evaluate(state, inputs());
    expect(h.rows.size).toBe(0);
    h.advance(1_000);
    await h.evaluator.evaluate(state, inputs());
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", evaluatedAt: h.now() });
    expect(h.written).toHaveLength(2);
  });

  it.each([
    { temperature: 90, effect: "full", verdict: "FULL", ruleState: "triggered" },
    { temperature: 90, effect: "avoid", verdict: "AVOID", ruleState: "triggered" },
    { temperature: 40, effect: "full", verdict: "NONE", ruleState: "clear" },
  ])(
    "rule-bearing control retains $verdict and its refresh budget with calm engine load",
    async ({ temperature, effect, verdict, ruleState }) => {
      const rules = [{ metric: "node.gpu.temperature_c", op: ">", threshold: 80, effect }];
      const h = harness([engineMember("m1", "VLLM", { ModelPool: { routingRules: rules } })]);
      const state = createRoutingEvaluationState("user-1", "device-1");
      const inputs = () => ({
        ...metrics(temperature, h.now()),
        endpointLoad: [load({ kvUsage: 0.2, receivedAt: h.now() })],
      });
      await h.evaluator.evaluate(state, inputs());
      expect(h.rows.get("m1")).toMatchObject({
        verdict,
        ruleStates: [ruleState],
        engineState: "clear",
      });
      h.advance(1_000);
      await h.evaluator.evaluate(state, inputs());
      expect(h.written).toHaveLength(1);
      h.advance(VERDICT_REFRESH_MS - 1_000);
      await h.evaluator.evaluate(state, inputs());
      expect(h.written).toHaveLength(2);
    },
  );
});

describe("MetricRoutingEvaluator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a FULL verdict for a member on this device whose rule triggers", async () => {
    const h = harness([member("m1", hotRule), member("m2", [])]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tier: "PRIMARY", ModelPool: { userId: "user-1" } }),
      }),
    );
    // Rule-less members get one successor fence, which never gates admission.
    expect([...h.rows.keys()]).toEqual(["m1", "m2"]);
    expect(h.rows.get("m2")).toMatchObject({ verdict: "NONE" });
    expect(h.db.poolMemberRoutingVerdict.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        poolMemberId: "m1",
        userId: "user-1",
        poolId: "pool-of-m1",
        cliDeviceId: "device-1",
        verdict: "FULL",
        ruleStates: ["triggered"],
        evaluatedAt: T0,
        // Built-ins are stale 90 s after receipt.
        expiresAt: new Date(T0.getTime() + 90_000),
      }),
    });
  });

  it("uses the member's own endpoint load for endpoint.* rules", async () => {
    const h = harness([member("m1", busyRule, "a"), member("m2", busyRule, "b")]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [
        { endpointSlug: "a", modelSlug: null, running: 1, waiting: 3, receivedAt: T0 },
        { endpointSlug: "b", modelSlug: null, running: 1, waiting: 0, receivedAt: T0 },
      ],
    });
    expect([...h.rows.values()].map((row) => [row.poolMemberId, row.verdict])).toEqual([
      ["m1", "AVOID"],
      ["m2", "NONE"],
    ]);
  });

  it("marks a rule stale (verdict none) when its metric is missing", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, { nodeMetrics: null, endpointLoad: [] });
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", ruleStates: ["stale"] });
  });

  it("rewrites an unchanged verdict only after the refresh interval, a changed one at once", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    const writes = () =>
      h.db.poolMemberRoutingVerdict.create.mock.calls.length +
      h.db.poolMemberRoutingVerdict.updateMany.mock.calls.length;
    // First evaluation: a miss on updateMany, then the create.
    expect(h.db.poolMemberRoutingVerdict.create).toHaveBeenCalledTimes(1);
    const afterFirst = writes();
    h.advance(VERDICT_REFRESH_MS);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(writes()).toBeGreaterThan(afterFirst);
    const afterRefresh = writes();
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(40, h.now()));
    expect(writes()).toBeGreaterThan(afterRefresh);
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("never overwrites a newer evaluation's verdict with an older one (stalled run, reconnect)", async () => {
    // Session A starts (t0) and stalls in its member read; session B starts
    // later (t0+50ms), writes NONE and finishes; A then resumes and tries to
    // publish its stale FULL. It must lose.
    const h = harness([member("m1", hotRule)]);
    const a = createRoutingEvaluationState("user-1", "device-1");
    const b = createRoutingEvaluationState("user-1", "device-1");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realFind = h.db.poolMember.findMany.getMockImplementation();
    h.db.poolMember.findMany.mockImplementationOnce(async () => {
      await gate;
      return realFind ? realFind() : [];
    });
    const first = h.evaluator.evaluate(a, metrics(90, T0));
    h.advance(50);
    await h.evaluator.evaluate(b, metrics(40, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
    release();
    await first;
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("an older evaluation that wins the create race is overwritten by the newer one", async () => {
    // Row absent: newer B's updateMany misses, older A creates first, then
    // B's create hits the unique violation. B must still win (its
    // evaluatedAt is newer), not read the violation as "a newer row exists".
    const h = harness([member("m1", hotRule)]);
    const older = createRoutingEvaluationState("user-1", "device-1");
    const newer = createRoutingEvaluationState("user-1", "device-1");
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    let ran = false;
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      // B's create is about to run: the older evaluation slips in first.
      if (!ran) {
        ran = true;
        h.advance(-50);
        await h.evaluator.evaluate(older, metrics(90, h.now()));
        h.advance(50);
      }
      return create ? create(args) : {};
    });
    await h.evaluator.evaluate(newer, metrics(40, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("an equal-millisecond write by another publisher never overwrites the first writer", async () => {
    // A (cancelled session) and B (its successor) evaluate in the same
    // millisecond. Whoever wrote first owns the row: a delayed write by the
    // other publisher is refused, and each publisher may refresh its own.
    const h = harness([member("m1", hotRule)]);
    const b = createRoutingEvaluationState("user-1", "device-1");
    const a = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(b, metrics(40, T0));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", publisherId: b.publisherId });
    await h.evaluator.evaluate(a, metrics(90, T0));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE", publisherId: b.publisherId });
    // The owner still refreshes at the same instant (same publisher).
    a.written.clear();
    b.written.clear();
    await h.evaluator.evaluate(b, metrics(90, T0));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL", publisherId: b.publisherId });
  });

  it("clears a pool's verdicts on request (the rule editor's hook)", async () => {
    const h = harness([member("m1", hotRule), member("m2", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.size).toBe(2);
    await h.evaluator.clearPool("pool-of-m1");
    expect([...h.rows.keys()]).toEqual(["m2"]);
  });

  it("re-writes at once after the pool's verdicts were cleared, even for an unchanged verdict", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.has("m1")).toBe(true);
    // Saving the same rules clears the verdicts; the next frame (one second
    // later, well inside the refresh interval) must write it back.
    await h.evaluator.clearPool("pool-of-m1");
    expect(h.rows.size).toBe(0);
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL" });
  });

  it("publishes nothing once its session was cancelled mid-evaluation", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realFind = h.db.poolMember.findMany.getMockImplementation();
    h.db.poolMember.findMany.mockImplementationOnce(async () => {
      await gate;
      return realFind ? realFind() : [];
    });
    const pending = h.evaluator.evaluate(state, metrics(90, T0));
    h.evaluator.cancel(state);
    release();
    await pending;
    expect(h.rows.size).toBe(0);
  });

  it("retracts a verdict written under rules that were edited during the evaluation", async () => {
    // The evaluation read the old rules; the edit (rules committed, then its
    // rows cleared) happens before the evaluation's write commits, so the
    // clearing missed it. The evaluation's re-check must remove it, and only
    // its own row.
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const publish = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (publish ? publish(args) : Promise.resolve({}));
      h.setRulesWithoutClearing("pool-of-m1", []);
      return result;
    });
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.size).toBe(0);
    // The retracted publication cannot count as a successful successor fence.
    h.db.poolMember.findMany.mockResolvedValue([member("m1", [])]);
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "NONE" });
  });

  it("retracts an engine FULL written under an override that was changed during the evaluation (S-D)", async () => {
    const members = [engineMember("m1", "VLLM")];
    const h = harness(members);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const publish = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (publish ? publish(args) : Promise.resolve({}));
      // The override edit committed (and its clearing already ran) before this write landed.
      members[0] = { ...members[0], engineLoadMode: "OFF" } as (typeof members)[number];
      return result;
    });
    await h.evaluator.evaluate(state, {
      nodeMetrics: null,
      endpointLoad: [load({ waiting: 3, waitingStreak: 2 })],
    });
    expect(h.rows.size).toBe(0);
  });

  it("stops publishing the remaining members once its session is cancelled between writes", async () => {
    const h = harness([member("m1", hotRule), member("m2", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const create = h.db.poolMemberRoutingVerdict.create.getMockImplementation();
    h.db.poolMemberRoutingVerdict.create.mockImplementationOnce(async (args) => {
      const result = await (create ? create(args) : Promise.resolve({}));
      h.evaluator.cancel(state);
      return result;
    });
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect([...h.rows.keys()]).toEqual(["m1"]);
  });

  it("keeps a verdict whose rules did not change while it was written", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL" });
    expect(h.db.poolMemberRoutingVerdict.deleteMany).not.toHaveBeenCalled();
  });

  it("re-writes at once after a rule edit even when the verdict is unchanged", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.evaluate(state, metrics(90, T0));
    const other = [{ metric: "node.gpu.temperature_c", op: ">", threshold: 70, effect: "full" }];
    h.editRules("pool-of-m1", other);
    h.db.poolMember.findMany.mockResolvedValue([member("m1", other)]);
    h.advance(1_000);
    await h.evaluator.evaluate(state, metrics(90, h.now()));
    expect(h.rows.get("m1")).toMatchObject({ verdict: "FULL" });
  });

  it("coalesces frames to one evaluation per device per second and stops when cancelled", async () => {
    const h = harness([member("m1", hotRule)]);
    const state = createRoutingEvaluationState("user-1", "device-1");
    const inputs = () => metrics(90, h.now());
    h.evaluator.schedule(state, inputs);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.evaluations()).toBe(1);
    h.evaluator.schedule(state, inputs);
    h.evaluator.schedule(state, inputs);
    h.evaluator.schedule(state, inputs);
    await vi.advanceTimersByTimeAsync(ROUTING_EVALUATION_MIN_INTERVAL_MS - 10);
    expect(h.evaluations()).toBe(1);
    h.advance(ROUTING_EVALUATION_MIN_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.evaluations()).toBe(2);
    h.evaluator.schedule(state, inputs);
    h.evaluator.cancel(state);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.evaluations()).toBe(2);
  });

  it("logs only the error class when an evaluation fails", async () => {
    const h = harness([]);
    h.db.poolMember.findMany.mockRejectedValueOnce(new TypeError("secret detail"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = createRoutingEvaluationState("user-1", "device-1");
    await h.evaluator.run(state, () => metrics(90, T0));
    expect(error).toHaveBeenCalledWith("[relay] metric routing evaluation failed", "TypeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
    error.mockRestore();
  });
});
