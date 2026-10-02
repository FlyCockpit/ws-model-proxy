/**
 * Per-device evaluation of metric routing rules (S-B part 2).
 *
 * On each accepted `node.metrics` or `endpoint.load` frame the relay session
 * schedules an evaluation of every pool member served by that device.
 * At most one evaluation runs per device per second (a frame
 * inside the window schedules one trailing run). Each member's verdict is
 * upserted into the H-class `pool_member_routing_verdict` table when it
 * changes, and otherwise refreshed at most every {@link VERDICT_REFRESH_MS}
 * so its `expiresAt` follows the metrics. Admission reads that table with a
 * plain, non-locking SELECT; this writer takes no capacity lock and the
 * table has no foreign keys, so it adds no lock-order edge (DL-1).
 *
 * S-D: the same run also turns the member's live engine load (vLLM/SGLang
 * waiting or KV pressure, llama.cpp busy slots or deferred requests) into a
 * FULL verdict, OR-combined with the rules (engine load only ever adds FULL).
 * A member without rules gets a row while engine load holds it FULL, plus
 * one clearing write. Each session also publishes once per member to fence
 * inherited or in-flight predecessor verdicts, including on reconnect. Idle
 * frames then stay quiet until membership changes. Clears and retractions
 * preserve NONE rows so their durable successor fences survive every process.
 *
 * The inputs are numbers, names and labels only; no prompt text reaches here.
 */

import { randomUUID } from "node:crypto";
import {
  type EngineLoadFacts,
  type EngineLoadVerdict,
  engineKindFromDb,
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

/** Minimum gap between two evaluations of one device. */
export const ROUTING_EVALUATION_MIN_INTERVAL_MS = 1_000;
/** An unchanged verdict is re-written at most this often (to extend `expiresAt`). */
export const VERDICT_REFRESH_MS = 5_000;

export type RoutingEvaluationInputs = {
  nodeMetrics: { sample: NodeMetricsSample; receivedAt: Date } | null;
  endpointLoad: readonly EndpointLoadSample[];
};

/** Held by one relay session. */
export type RoutingEvaluationState = {
  /** Identifies this state as the publisher of the verdict rows it writes. */
  publisherId: string;
  userId: string;
  cliDeviceId: string;
  lastRunAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerun: boolean;
  closed: boolean;
  written: Map<string, { key: string; writtenAtMs: number; epoch: number }>;
  /** Members successfully published by this session, including idle successor fences. */
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
  cliDeviceId: string,
): RoutingEvaluationState {
  return {
    publisherId: randomUUID(),
    userId,
    cliDeviceId,
    lastRunAtMs: null,
    timer: null,
    running: false,
    rerun: false,
    closed: false,
    written: new Map(),
    probed: new Set(),
  };
}

type Db = Pick<typeof prisma, "poolMember" | "poolMemberRoutingVerdict" | "modelPool">;

const VERDICT_TO_DB = { none: "NONE", avoid: "AVOID", full: "FULL" } as const satisfies Record<
  RoutingVerdict,
  "NONE" | "AVOID" | "FULL"
>;

/** The rules an evaluation used, in a form that compares by value. */
function rulesKey(rules: unknown): string {
  return JSON.stringify(rules);
}

/** The member's engine-load override an evaluation used, compared by value. */
function overrideKey(mode: string, kvFullThreshold: number | null, customMode?: string): string {
  return `${mode}:${kvFullThreshold ?? ""}:${customMode ?? ""}`;
}

type PublishedEntry = {
  memberId: string;
  poolId: string;
  rulesKey: string;
  overrideKey: string;
};

type VerdictData = {
  publisherId: string;
  userId: string;
  poolId: string;
  cliDeviceId: string;
  verdict: "NONE" | "AVOID" | "FULL";
  ruleStates: string[];
  engineState: string;
  evaluatedAt: Date;
  expiresAt: Date;
};

export class MetricRoutingEvaluator {
  /** Bumped when a pool's verdicts are cleared, so cached "already written" entries stop applying. */
  private clearEpoch = 0;

  constructor(
    private readonly db: Db = prisma,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Request an evaluation; coalesced to one run per device per second. */
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
    // The evaluation's own time, taken BEFORE anything is read: it orders
    // this evaluation against every other one for the same member (see
    // `publish`), so a run that stalls in a query cannot later overwrite a
    // verdict a newer run already wrote.
    const now = this.clock();
    // Cached writes belong to the epoch captured before reads: a clear
    // during publication must invalidate them on the next run. Idle probes
    // remain valid because clears preserve their durable NONE fences.
    const epoch = this.clearEpoch;
    const members = await this.db.poolMember.findMany({
      where: {
        tier: "PRIMARY",
        ModelPool: { userId: state.userId },
        OR: [
          {
            ExecutionTarget: { DiscoveredModel: { Endpoint: { cliDeviceId: state.cliDeviceId } } },
          },
          {
            executionTargetId: null,
            DiscoveredModel: { Endpoint: { cliDeviceId: state.cliDeviceId } },
          },
        ],
      },
      select: {
        id: true,
        poolId: true,
        engineLoadMode: true,
        customEngineLoadMode: true,
        kvFullThreshold: true,
        ModelPool: {
          select: {
            PoolRoutingRules: {
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
            },
          },
        },
        DiscoveredModel: { select: { slug: true, Endpoint: { select: { slug: true } } } },
        ExecutionTarget: {
          select: {
            InferenceCapacity: {
              select: {
                engineKind: true,
                engineSlots: true,
                engineLoadSource: true,
                engineLoadSignals: true,
              },
            },
            DiscoveredModel: { select: { slug: true, Endpoint: { select: { slug: true } } } },
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
    for (const member of members) {
      const rules = routingRulesFromRows(member.ModelPool.PoolRoutingRules ?? []);
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      if (!model) continue;
      const memberRef = { endpointSlug: model.Endpoint.slug, modelSlug: model.slug ?? null };
      const capacity = member.ExecutionTarget?.InferenceCapacity ?? null;
      const reading = pickEndpointLoad(inputs.endpointLoad, memberRef);
      const loadSource =
        capacity?.engineLoadSource === "CUSTOM" || reading?.source === "custom"
          ? ("custom" as const)
          : ("builtin" as const);
      const facts: EngineLoadFacts = {
        engineKind: engineKindFromDb(capacity?.engineKind),
        engineSlots: capacity?.engineSlots ?? null,
        mode: member.engineLoadMode === "OFF" ? "OFF" : "AUTO",
        kvFullThreshold: member.kvFullThreshold ?? null,
        loadSource,
        signals: capacity?.engineLoadSignals ?? [],
        customMode: member.customEngineLoadMode === "ENFORCE" ? "ENFORCE" : "OBSERVE",
      };
      const engine = evaluateEngineLoad(
        facts,
        reading ? { ...reading, waitingStreak: reading.waitingStreak ?? 0 } : null,
        now,
      );
      const previous = state.written.get(member.id);
      seen.add(member.id);
      // Empty session memory may hide inherited FULL or an older publication
      // still in flight. Publish one NONE fence before skipping idle frames.
      if (rules.length === 0 && !engine.full && !previous && state.probed.has(member.id)) continue;
      const series = [...nodeSeries, ...endpointLoadSeries(inputs.endpointLoad, memberRef, now)];
      const evaluation = combineWithEngineLoad(
        rules.length === 0
          ? { verdict: "none", ruleStates: [], expiresAt: now }
          : evaluateRoutingRules(rules, series, now, member.id),
        engine,
      );
      // Rules and overrides invalidate the cache even when edited on another process.
      const key = `${evaluation.verdict}:${evaluation.ruleStates.join(",")}:${engine.state}:${engine.enforced}:${rulesKey(rules)}:${overrideKey(facts.mode, facts.kvFullThreshold, facts.customMode)}`;
      if (
        previous &&
        previous.key === key &&
        previous.epoch === epoch &&
        nowMs - previous.writtenAtMs < VERDICT_REFRESH_MS
      ) {
        continue;
      }
      const data = {
        publisherId: state.publisherId,
        userId: state.userId,
        poolId: member.poolId,
        cliDeviceId: state.cliDeviceId,
        verdict: VERDICT_TO_DB[evaluation.verdict],
        ruleStates: evaluation.ruleStates,
        engineState: engine.state,
        evaluatedAt: now,
        expiresAt: evaluation.expiresAt,
      };
      // The session ended while an earlier write was in flight: publish nothing more.
      if (state.closed) break;
      if (await this.publish(member.id, data)) {
        state.probed.add(member.id);
        // A rule-less member's NONE fence never gates and needs no refresh,
        // so only FULL verdicts remain in the cached writes.
        if (rules.length === 0 && evaluation.verdict === "none") state.written.delete(member.id);
        else state.written.set(member.id, { key, writtenAtMs: nowMs, epoch });
        published.push({
          memberId: member.id,
          poolId: member.poolId,
          rulesKey: rulesKey(rules),
          overrideKey: overrideKey(facts.mode, facts.kvFullThreshold, facts.customMode),
        });
      }
    }
    await this.retractIfRulesChanged(state, published, now);
    for (const memberId of state.written.keys()) {
      if (!seen.has(memberId)) state.written.delete(memberId);
    }
    for (const memberId of state.probed) {
      if (!seen.has(memberId)) state.probed.delete(memberId);
    }
  }
  /**
   * The ONE write of a verdict: never older than what is stored. The row is
   * replaced only when its `evaluatedAt` is strictly older than this
   * evaluation's, or is this same publisher's own row (an equal timestamp
   * from ANOTHER publisher belongs to whoever wrote first, so a cancelled
   * session's delayed write cannot overwrite its successor even within one
   * millisecond). A missing row is created, and losing that creation race
   * (unique violation) is decided again the same way. True when this
   * evaluation's verdict is now the stored one.
   */
  private async publish(memberId: string, data: VerdictData): Promise<boolean> {
    const replaceable = {
      poolMemberId: memberId,
      OR: [
        { evaluatedAt: { lt: data.evaluatedAt } },
        { evaluatedAt: data.evaluatedAt, publisherId: data.publisherId },
      ],
    };
    const updated = await this.db.poolMemberRoutingVerdict.updateMany({
      where: replaceable,
      data,
    });
    if (updated.count > 0) return true;
    try {
      await this.db.poolMemberRoutingVerdict.create({ data: { poolMemberId: memberId, ...data } });
      return true;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
      // Another evaluation created the row first. It may be an OLDER one, so
      // decide by `evaluatedAt` again instead of assuming a newer wrote.
      const retried = await this.db.poolMemberRoutingVerdict.updateMany({
        where: replaceable,
        data,
      });
      return retried.count > 0;
    }
  }

  /**
   * A rule edit or engine-load override change can commit between what this
   * evaluation read and its write. After the write is committed, re-read the
   * pools and members: if their rules or override differ, the edit's clear
   * may have missed our publication, so delete
   * exactly the gating rows this evaluation wrote (a newer evaluation's row
   * has a different `evaluatedAt` or publisher and is kept). NONE rows stay
   * as durable successor fences even when their snapshot is outdated.
   * A gating row committed before the re-read is either seen here or
   * deleted by the edit's own clearing,
   * because the edit clears after its rules commit.
   */
  private async retractIfRulesChanged(
    state: RoutingEvaluationState,
    published: readonly PublishedEntry[],
    evaluatedAt: Date,
  ): Promise<void> {
    if (published.length === 0) return;
    const poolIds = [...new Set(published.map((entry) => entry.poolId))];
    const pools = await this.db.modelPool.findMany({
      where: { id: { in: poolIds } },
      select: {
        id: true,
        PoolRoutingRules: {
          orderBy: { position: "asc" },
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
        },
      },
    });
    const current = new Map(
      pools.map((pool) => [pool.id, rulesKey(routingRulesFromRows(pool.PoolRoutingRules ?? []))]),
    );
    const members = await this.db.poolMember.findMany({
      where: { id: { in: published.map((entry) => entry.memberId) } },
      select: { id: true, engineLoadMode: true, customEngineLoadMode: true, kvFullThreshold: true },
    });
    const currentOverride = new Map(
      members.map((member) => [
        member.id,
        overrideKey(
          member.engineLoadMode === "OFF" ? "OFF" : "AUTO",
          member.kvFullThreshold,
          member.customEngineLoadMode === "ENFORCE" ? "ENFORCE" : "OBSERVE",
        ),
      ]),
    );
    const stale = published.filter(
      (entry) =>
        current.get(entry.poolId) !== entry.rulesKey ||
        currentOverride.get(entry.memberId) !== entry.overrideKey,
    );
    if (stale.length === 0) return;
    await this.db.poolMemberRoutingVerdict.deleteMany({
      where: {
        poolMemberId: { in: stale.map((entry) => entry.memberId) },
        evaluatedAt,
        publisherId: state.publisherId,
        verdict: { not: "NONE" },
      },
    });
    for (const entry of stale) {
      state.written.delete(entry.memberId);
      state.probed.delete(entry.memberId);
    }
  }

  /**
   * A pool's rules were replaced (the rule editor committed): its stored
   * gating verdicts belong to the old rules. Cleared here, in the hot-path (H)
   * module, because a management writer must not write H tables; an
   * evaluation still in flight is retracted by `retractIfRulesChanged`.
   */
  async clearPool(poolId: string): Promise<void> {
    // Cached verdicts are re-written at once afterwards (also for rules
    // saved unchanged). Idle rule-less members retain their NONE fences
    // without re-probing; deleting those rows could admit a delayed older write.
    this.clearEpoch += 1;
    await this.db.poolMemberRoutingVerdict.deleteMany({
      where: { poolId, verdict: { not: "NONE" } },
    });
  }
}
