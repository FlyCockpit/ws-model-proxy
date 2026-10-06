/**
 * Per-node evaluation of metric routing rules and engine load, keyed (pool member × execution
 * target) in 0.4.0: a LOCAL member names a served model, and each instance serving it is one
 * target, so a member can be FULL on one instance and free on another.
 *
 * On each accepted `node.metrics` or `runtime.load` frame the relay session schedules an
 * evaluation of every (member, target) pair whose instance's head runs on that node. At most
 * one evaluation runs per node per second (a frame inside the window schedules one trailing
 * run). Each verdict is upserted into the H-class `routing_verdict` table when it changes, and
 * otherwise refreshed at most every {@link VERDICT_REFRESH_MS} so its `expiresAt` follows the
 * metrics. Admission reads that table with a plain, non-locking SELECT; this writer takes no
 * capacity lock and the table has no foreign keys, so it adds no lock-order edge (DL-1).
 *
 * The same run turns the instance's live engine load (vLLM/SGLang waiting or KV pressure,
 * llama.cpp busy slots or deferred requests) into a FULL verdict, OR-combined with the rules.
 * The engine-load gate is the runtime version's (`AUTO`, `ENFORCE`, `OBSERVE`). Each session
 * publishes once per pair to fence inherited or in-flight predecessor verdicts. Clears and
 * retractions keep NONE rows so their durable successor fences survive every process.
 *
 * The inputs are numbers, names and labels only; no prompt text reaches here.
 */

import { randomUUID } from "node:crypto";
import {
  type EngineKind,
  type EngineLoadFacts,
  type EngineLoadVerdict,
  evaluateEngineLoad,
} from "@ws-model-proxy/api/lib/engine-load";
import {
  type EndpointLoadSample,
  endpointLoadSeries,
  evaluateRoutingRules,
  type NodeMetricsSample,
  nodeMetricSeries,
  pickEndpointLoad,
  type RoutingEvaluation,
  type RoutingVerdict,
  routingRulesFromRows,
} from "@ws-model-proxy/api/lib/metric-routing";
import prisma from "@ws-model-proxy/db";

/** Minimum gap between two evaluations of one node. */
export const ROUTING_EVALUATION_MIN_INTERVAL_MS = 1_000;
/** An unchanged verdict is re-written at most this often (to extend `expiresAt`). */
export const VERDICT_REFRESH_MS = 5_000;

/**
 * A live `runtime.load` reading as the evaluator matches it: `endpointSlug` is the instance
 * handle, `modelSlug` the served model (null: instance-wide).
 */
export type RuntimeLoadReading = EndpointLoadSample;

export type RoutingEvaluationInputs = {
  nodeMetrics: { sample: NodeMetricsSample; receivedAt: Date } | null;
  runtimeLoad: readonly RuntimeLoadReading[];
};

/** Held by one relay session. */
export type RoutingEvaluationState = {
  /** Identifies this state as the publisher of the verdict rows it writes. */
  publisherId: string;
  /** The node's owner (only their instances run on it). */
  userId: string;
  nodeId: string;
  lastRunAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerun: boolean;
  closed: boolean;
  written: Map<string, { key: string; writtenAtMs: number; epoch: number }>;
  /** Pairs successfully published by this session, including idle successor fences. */
  probed: Set<string>;
};

/** Rule verdict OR engine-load verdict: engine load only adds FULL when enforced. */
export function combineWithEngineLoad(
  rules: RoutingEvaluation,
  engine: EngineLoadVerdict,
): RoutingEvaluation {
  if (!engine.full || !engine.enforced || !engine.expiresAt) return rules;
  const expiresAt =
    rules.verdict === "full" && rules.expiresAt.getTime() > engine.expiresAt.getTime()
      ? rules.expiresAt
      : engine.expiresAt;
  return { verdict: "full", ruleStates: rules.ruleStates, expiresAt };
}

export function createRoutingEvaluationState(
  userId: string,
  nodeId: string,
): RoutingEvaluationState {
  return {
    publisherId: randomUUID(),
    userId,
    nodeId,
    lastRunAtMs: null,
    timer: null,
    running: false,
    rerun: false,
    closed: false,
    written: new Map(),
    probed: new Set(),
  };
}

type Db = Pick<typeof prisma, "executionTarget" | "routingVerdict" | "pool">;

const VERDICT_TO_DB = { none: "NONE", avoid: "AVOID", full: "FULL" } as const satisfies Record<
  RoutingVerdict,
  "NONE" | "AVOID" | "FULL"
>;

/** The 0.4.0 engine vocabulary as the engine-load evaluator names it. */
const ENGINE_TO_KIND: Readonly<Record<string, EngineKind>> = {
  VLLM: "VLLM",
  SGLANG: "SGLANG",
  LLAMA_CPP: "LLAMA_CPP",
  OLLAMA: "OLLAMA",
  LM_STUDIO: "LM_STUDIO",
  OTHER: "GENERIC",
};

/** The version's engine-load gate as the evaluator's mode pair. */
export function gateFacts(gate: string | null | undefined): {
  mode: EngineLoadFacts["mode"];
  customMode: NonNullable<EngineLoadFacts["customMode"]>;
} {
  if (gate === "OBSERVE") return { mode: "OFF", customMode: "OBSERVE" };
  if (gate === "ENFORCE") return { mode: "AUTO", customMode: "ENFORCE" };
  return { mode: "AUTO", customMode: "OBSERVE" };
}

/** The rules an evaluation used, in a form that compares by value. */
function rulesKey(rules: unknown): string {
  return JSON.stringify(rules);
}

/** The instance's engine-load gate an evaluation used, compared by value. */
function overrideKey(gate: string | null, kvFullThreshold: number | null): string {
  return `${gate ?? ""}:${kvFullThreshold ?? ""}`;
}

function pairKey(memberId: string, targetId: string): string {
  return `${memberId}\u0000${targetId}`;
}

type PublishedEntry = {
  memberId: string;
  targetId: string;
  poolId: string;
  rulesKey: string;
  overrideKey: string;
};

type VerdictData = {
  publisherId: string;
  userId: string;
  poolId: string;
  nodeId: string;
  verdict: "NONE" | "AVOID" | "FULL";
  ruleStates: string[];
  engineState: string;
  evaluatedAt: Date;
  expiresAt: Date;
};

const RULE_SELECT = {
  orderBy: { position: "asc" as const },
  select: {
    position: true,
    metric: true,
    labels: true,
    aggregate: true,
    op: true,
    threshold: true,
    effect: true,
    memberId: true,
    exclude: true,
  },
};

/** Targets whose instance's head runs on the node (always-on: the runtime's node; else rank 0). */
function headOnNode(userId: string, nodeId: string) {
  return {
    kind: "INSTANCE_MODEL" as const,
    userId,
    Instance: {
      OR: [{ Runtime: { nodeId } }, { Ranks: { some: { rank: 0, nodeId } } }],
    },
  };
}

export class MetricRoutingEvaluator {
  /** Bumped when a pool's verdicts are cleared, so cached "already written" entries stop applying. */
  private clearEpoch = 0;

  constructor(
    private readonly db: Db = prisma,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Request an evaluation; coalesced to one run per node per second. */
  schedule(state: RoutingEvaluationState, inputs: () => RoutingEvaluationInputs): void {
    if (state.closed) return;
    if (state.running) {
      state.rerun = true;
      return;
    }
    if (state.timer) return;
    const nowMs = this.clock().getTime();
    const waitMs =
      state.lastRunAtMs === null
        ? 0
        : Math.max(0, state.lastRunAtMs + ROUTING_EVALUATION_MIN_INTERVAL_MS - nowMs);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.run(state, inputs);
    }, waitMs);
    state.timer.unref?.();
  }

  /** The session ended: drop any pending run. Written verdicts expire on their own. */
  cancel(state: RoutingEvaluationState): void {
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  async run(state: RoutingEvaluationState, inputs: () => RoutingEvaluationInputs): Promise<void> {
    if (state.closed) return;
    state.running = true;
    state.lastRunAtMs = this.clock().getTime();
    try {
      await this.evaluate(state, inputs());
    } catch (error) {
      console.error(
        "[relay] metric routing evaluation failed",
        error instanceof Error ? error.name : typeof error,
      );
    } finally {
      state.running = false;
      if (state.rerun && !state.closed) {
        state.rerun = false;
        this.schedule(state, inputs);
      }
    }
  }

  async evaluate(state: RoutingEvaluationState, inputs: RoutingEvaluationInputs): Promise<void> {
    // The evaluation's own time, taken BEFORE anything is read: it orders this evaluation
    // against every other one for the same pair (see `publish`).
    const now = this.clock();
    const epoch = this.clearEpoch;
    const targets = await this.db.executionTarget.findMany({
      where: headOnNode(state.userId, state.nodeId),
      select: {
        id: true,
        Instance: {
          select: {
            handle: true,
            engineSlots: true,
            loadSignals: true,
            Version: { select: { engine: true, engineLoadGate: true, kvFullThreshold: true } },
          },
        },
        RuntimeModel: {
          select: {
            upstreamModelId: true,
            Members: {
              where: { kind: "LOCAL" as const },
              select: {
                id: true,
                poolId: true,
                Pool: { select: { userId: true, RoutingRules: RULE_SELECT } },
              },
            },
          },
        },
      },
    });
    if (state.closed) return;
    const nowMs = now.getTime();
    const nodeSeries = inputs.nodeMetrics
      ? nodeMetricSeries(inputs.nodeMetrics.sample, inputs.nodeMetrics.receivedAt, now)
      : [];
    const seen = new Set<string>();
    const published: PublishedEntry[] = [];
    for (const target of targets) {
      const instance = target.Instance;
      const model = target.RuntimeModel;
      if (!instance || !model) continue;
      const ref = { endpointSlug: instance.handle, modelSlug: model.upstreamModelId };
      const reading = pickEndpointLoad(inputs.runtimeLoad, ref);
      const gate = gateFacts(instance.Version.engineLoadGate);
      const facts: EngineLoadFacts = {
        engineKind: ENGINE_TO_KIND[instance.Version.engine ?? ""] ?? null,
        engineSlots: instance.engineSlots ?? null,
        mode: gate.mode,
        kvFullThreshold: instance.Version.kvFullThreshold ?? null,
        loadSource:
          reading?.source === "route" || reading?.source === "command" ? "custom" : "builtin",
        signals: instance.loadSignals,
        customMode: gate.customMode,
      };
      const engine = evaluateEngineLoad(
        facts,
        reading ? { ...reading, waitingStreak: reading.waitingStreak ?? 0 } : null,
        now,
      );
      const series = [...nodeSeries, ...endpointLoadSeries(inputs.runtimeLoad, ref, now)];
      for (const member of model.Members) {
        const rules = routingRulesFromRows(member.Pool.RoutingRules ?? []);
        const pair = pairKey(member.id, target.id);
        const previous = state.written.get(pair);
        seen.add(pair);
        // Empty session memory may hide inherited FULL or an older publication still in
        // flight. Publish one NONE fence before skipping idle frames.
        if (rules.length === 0 && !engine.full && !previous && state.probed.has(pair)) continue;
        const evaluation = combineWithEngineLoad(
          rules.length === 0
            ? { verdict: "none", ruleStates: [], expiresAt: now }
            : evaluateRoutingRules(rules, series, now, member.id),
          engine,
        );
        const override = overrideKey(
          instance.Version.engineLoadGate,
          instance.Version.kvFullThreshold ?? null,
        );
        const key = `${evaluation.verdict}:${evaluation.ruleStates.join(",")}:${engine.state}:${engine.enforced}:${rulesKey(rules)}:${override}`;
        if (
          previous &&
          previous.key === key &&
          previous.epoch === epoch &&
          nowMs - previous.writtenAtMs < VERDICT_REFRESH_MS
        ) {
          continue;
        }
        const data: VerdictData = {
          publisherId: state.publisherId,
          userId: member.Pool.userId,
          poolId: member.poolId,
          nodeId: state.nodeId,
          verdict: VERDICT_TO_DB[evaluation.verdict],
          ruleStates: evaluation.ruleStates,
          engineState: engine.state,
          evaluatedAt: now,
          expiresAt: evaluation.expiresAt,
        };
        // The session ended while an earlier write was in flight: publish nothing more.
        if (state.closed) return;
        if (await this.publish(member.id, target.id, data)) {
          state.probed.add(pair);
          // A rule-less pair's NONE fence never gates and needs no refresh.
          if (rules.length === 0 && evaluation.verdict === "none") state.written.delete(pair);
          else state.written.set(pair, { key, writtenAtMs: nowMs, epoch });
          published.push({
            memberId: member.id,
            targetId: target.id,
            poolId: member.poolId,
            rulesKey: rulesKey(rules),
            overrideKey: override,
          });
        }
      }
    }
    await this.retractIfRulesChanged(state, published, now);
    for (const pair of state.written.keys()) if (!seen.has(pair)) state.written.delete(pair);
    for (const pair of state.probed) if (!seen.has(pair)) state.probed.delete(pair);
  }

  /**
   * The ONE write of a verdict: never older than what is stored. The row is replaced only
   * when its `evaluatedAt` is strictly older than this evaluation's, or is this same
   * publisher's own row. A missing row is created, and losing that creation race (unique
   * violation) is decided again the same way. True when this verdict is now the stored one.
   */
  private async publish(memberId: string, targetId: string, data: VerdictData): Promise<boolean> {
    const replaceable = {
      poolMemberId: memberId,
      executionTargetId: targetId,
      OR: [
        { evaluatedAt: { lt: data.evaluatedAt } },
        { evaluatedAt: data.evaluatedAt, publisherId: data.publisherId },
      ],
    };
    const updated = await this.db.routingVerdict.updateMany({ where: replaceable, data });
    if (updated.count > 0) return true;
    try {
      await this.db.routingVerdict.create({
        data: { poolMemberId: memberId, executionTargetId: targetId, ...data },
      });
      return true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
      const retried = await this.db.routingVerdict.updateMany({ where: replaceable, data });
      return retried.count > 0;
    }
  }

  /**
   * A rule edit or engine-load gate change can commit between what this evaluation read and
   * its write. Re-read the pools and the instances' versions after the write: if they differ,
   * delete exactly the gating rows this evaluation wrote. NONE rows stay as successor fences.
   */
  private async retractIfRulesChanged(
    state: RoutingEvaluationState,
    published: readonly PublishedEntry[],
    evaluatedAt: Date,
  ): Promise<void> {
    if (published.length === 0) return;
    const poolIds = [...new Set(published.map((entry) => entry.poolId))];
    const pools = await this.db.pool.findMany({
      where: { id: { in: poolIds } },
      select: { id: true, RoutingRules: RULE_SELECT },
    });
    const currentRules = new Map(
      pools.map((pool) => [pool.id, rulesKey(routingRulesFromRows(pool.RoutingRules ?? []))]),
    );
    const targets = await this.db.executionTarget.findMany({
      where: { id: { in: [...new Set(published.map((entry) => entry.targetId))] } },
      select: {
        id: true,
        Instance: {
          select: { Version: { select: { engineLoadGate: true, kvFullThreshold: true } } },
        },
      },
    });
    const currentOverride = new Map(
      targets.map((target) => [
        target.id,
        overrideKey(
          target.Instance?.Version.engineLoadGate ?? null,
          target.Instance?.Version.kvFullThreshold ?? null,
        ),
      ]),
    );
    const stale = published.filter(
      (entry) =>
        currentRules.get(entry.poolId) !== entry.rulesKey ||
        currentOverride.get(entry.targetId) !== entry.overrideKey,
    );
    for (const entry of stale) {
      await this.db.routingVerdict.deleteMany({
        where: {
          poolMemberId: entry.memberId,
          executionTargetId: entry.targetId,
          evaluatedAt,
          publisherId: state.publisherId,
          verdict: { not: "NONE" },
        },
      });
      const pair = pairKey(entry.memberId, entry.targetId);
      state.written.delete(pair);
      state.probed.delete(pair);
    }
  }

  /**
   * A pool's rules were replaced (the rule editor committed): its stored gating verdicts
   * belong to the old rules. Cleared here, in the hot-path (H) module, because a management
   * writer must not write H tables; an evaluation still in flight is retracted above.
   */
  async clearPool(poolId: string): Promise<void> {
    this.clearEpoch += 1;
    await this.db.routingVerdict.deleteMany({ where: { poolId, verdict: { not: "NONE" } } });
  }
}
