/**
 * Per-device evaluation of metric routing rules (S-B part 2).
 *
 * On each accepted `node.metrics` or `endpoint.load` frame the relay session
 * schedules an evaluation of every pool member served by that device whose
 * pool has rules. At most one evaluation runs per device per second (a frame
 * inside the window schedules one trailing run). Each member's verdict is
 * upserted into the H-class `pool_member_routing_verdict` table when it
 * changes, and otherwise refreshed at most every {@link VERDICT_REFRESH_MS}
 * so its `expiresAt` follows the metrics. Admission reads that table with a
 * plain, non-locking SELECT; this writer takes no capacity lock and the
 * table has no foreign keys, so it adds no lock-order edge (DL-1).
 *
 * The inputs are numbers, names and labels only; no prompt text reaches here.
 */

import {
  type EndpointLoadSample,
  endpointLoadSeries,
  evaluateRoutingRules,
  type NodeMetricsSample,
  nodeMetricSeries,
  parseStoredRoutingRules,
  type RoutingVerdict,
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
  userId: string;
  cliDeviceId: string;
  lastRunAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  rerun: boolean;
  closed: boolean;
  written: Map<string, { key: string; writtenAtMs: number }>;
};

export function createRoutingEvaluationState(
  userId: string,
  cliDeviceId: string,
): RoutingEvaluationState {
  return {
    userId,
    cliDeviceId,
    lastRunAtMs: null,
    timer: null,
    running: false,
    rerun: false,
    closed: false,
    written: new Map(),
  };
}

type Db = Pick<typeof prisma, "poolMember" | "poolMemberRoutingVerdict">;

const VERDICT_TO_DB = { none: "NONE", avoid: "AVOID", full: "FULL" } as const satisfies Record<
  RoutingVerdict,
  "NONE" | "AVOID" | "FULL"
>;

export class MetricRoutingEvaluator {
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
        ModelPool: { select: { routingRules: true } },
        DiscoveredModel: { select: { slug: true, Endpoint: { select: { slug: true } } } },
        ExecutionTarget: {
          select: {
            DiscoveredModel: { select: { slug: true, Endpoint: { select: { slug: true } } } },
          },
        },
      },
    });
    const now = this.clock();
    const nowMs = now.getTime();
    const nodeSeries = inputs.nodeMetrics
      ? nodeMetricSeries(inputs.nodeMetrics.sample, inputs.nodeMetrics.receivedAt, now)
      : [];
    const seen = new Set<string>();
    for (const member of members) {
      const rules = parseStoredRoutingRules(member.ModelPool.routingRules);
      if (rules.length === 0) continue;
      const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
      if (!model) continue;
      seen.add(member.id);
      const series = [
        ...nodeSeries,
        ...endpointLoadSeries(
          inputs.endpointLoad,
          { endpointSlug: model.Endpoint.slug, modelSlug: model.slug ?? null },
          now,
        ),
      ];
      const evaluation = evaluateRoutingRules(rules, series, now);
      const key = `${evaluation.verdict}:${evaluation.ruleStates.join(",")}`;
      const previous = state.written.get(member.id);
      if (previous && previous.key === key && nowMs - previous.writtenAtMs < VERDICT_REFRESH_MS) {
        continue;
      }
      const data = {
        userId: state.userId,
        poolId: member.poolId,
        cliDeviceId: state.cliDeviceId,
        verdict: VERDICT_TO_DB[evaluation.verdict],
        ruleStates: evaluation.ruleStates,
        evaluatedAt: now,
        expiresAt: evaluation.expiresAt,
      };
      await this.db.poolMemberRoutingVerdict.upsert({
        where: { poolMemberId: member.id },
        create: { poolMemberId: member.id, ...data },
        update: data,
      });
      state.written.set(member.id, { key, writtenAtMs: nowMs });
    }
    for (const memberId of state.written.keys()) {
      if (!seen.has(memberId)) state.written.delete(memberId);
    }
  }
}
