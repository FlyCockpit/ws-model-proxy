/**
 * Half-open recovery of execution targets served by this process's node sockets (was
 * pool-member-recovery; health lives on `execution_target` in 0.4.0, one row per served model
 * on one instance). Recovery lives beside the relay sockets rather than in a process-wide
 * worker: a websocket is process-local, so only its owning process can send a probe and
 * settle the observation.
 *
 * The health transitions (claim, settle, abandon; the node disconnect/reconnect circuit) are
 * the shared ones in `@ws-model-proxy/api/lib/pool-routing`; this module only decides which
 * targets this process can probe and builds the probe.
 */
import {
  abandonTargetRecoveryTrial,
  claimTargetRecoveryTrial,
  settleTargetRecoveryTrial,
} from "@ws-model-proxy/api/lib/pool-routing";
import prisma from "@ws-model-proxy/db";

export const TARGET_RECOVERY_PROBE_TIMEOUT_MS = 20_000;
export const TARGET_RECOVERY_IDLE_POLL_MS = 1_000;

/** One target to probe, through the node session that serves its instance's head. */
export type RecoveryTarget = {
  id: string;
  nodeId: string;
  /** The node routes by it: the runtime slug (always-on) or `i-<id12>` (startable). */
  handle: string;
  upstreamModelId: string;
  api: "OPENAI" | "ANTHROPIC";
};

type Timer = ReturnType<typeof setTimeout>;

export type TargetRecoverySchedulerDependencies = {
  getOwnedNodeIds(): Iterable<string>;
  listDueTargets(nodeIds: string[], now: Date): Promise<RecoveryTarget[]>;
  /**
   * `"superseded"`: the connection the probe ran on was replaced or lost, so the result says
   * nothing about the target (never recorded as a failure).
   */
  probe(target: RecoveryTarget): Promise<boolean | "superseded">;
  now?(): Date;
  setTimer?(callback: () => void, ms: number): Timer;
  clearTimer?(timer: Timer): void;
  idlePollMs?: number;
  claim?(targetId: string, now: Date): Promise<Date | null>;
  abandon?(input: { executionTargetId: string; trialStartedAt: Date; now: Date }): Promise<boolean>;
  settle?(input: {
    executionTargetId: string;
    trialStartedAt: Date;
    healthy: boolean;
    now: Date;
  }): Promise<boolean>;
};

export class TargetRecoveryScheduler {
  private timer: Timer | null = null;
  private running = false;
  private stopped = false;
  private wakeRequested = false;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly dependencies: TargetRecoverySchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Start or promptly rescan after a local node session is registered. */
  wake() {
    if (this.stopped) return;
    if (![...this.dependencies.getOwnedNodeIds()].length) {
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      return;
    }
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (this.stopped || this.timer || this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  private owns(nodeId: string): boolean {
    return new Set(this.dependencies.getOwnedNodeIds()).has(nodeId);
  }

  private async run() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const ownedIds = [...new Set(this.dependencies.getOwnedNodeIds())];
      if (ownedIds.length > 0) {
        const targets = await this.dependencies.listDueTargets(ownedIds, this.now());
        for (const target of targets) {
          // A session can be replaced after the query: never probe or write health for a
          // target whose socket this process no longer owns.
          if (!this.owns(target.nodeId)) continue;
          const claim =
            this.dependencies.claim ??
            ((executionTargetId: string, now: Date) =>
              claimTargetRecoveryTrial({ executionTargetId, now }));
          const trialStartedAt = await claim(target.id, this.now());
          if (!trialStartedAt) continue;
          // Every claimed trial ends in settle or abandon.
          const abandon = () =>
            (this.dependencies.abandon ?? abandonTargetRecoveryTrial)({
              executionTargetId: target.id,
              trialStartedAt,
              now: this.now(),
            });
          try {
            const healthy = await this.dependencies.probe(target).catch(() => false);
            if (healthy === "superseded" || !this.owns(target.nodeId)) {
              await abandon();
              if (healthy === "superseded") this.wakeRequested = true;
              continue;
            }
            await (this.dependencies.settle ?? settleTargetRecoveryTrial)({
              executionTargetId: target.id,
              trialStartedAt,
              healthy,
              now: this.now(),
            });
          } catch (error) {
            await abandon().catch(() => false);
            throw error;
          }
        }
      }
    } catch {
      // A transient database failure must not become an unhandled rejection; the next
      // bounded tick retries the scan.
    } finally {
      this.running = false;
      if (this.stopped) {
        // stop() already cancelled the pending timer.
      } else if (![...this.dependencies.getOwnedNodeIds()].length) {
        this.wakeRequested = false;
      } else if (this.wakeRequested) {
        this.wakeRequested = false;
        this.schedule(0);
      } else {
        this.schedule(this.dependencies.idlePollMs ?? TARGET_RECOVERY_IDLE_POLL_MS);
      }
    }
  }
}

/**
 * Due targets on the owned nodes: unhealthy or degraded, retry time passed, served by an
 * instance whose head runs on one of the nodes, with a chat-capable LLM model (other model
 * types have no safe probe and are never turned into transport failures by recovery).
 */
export async function listDueOwnedTargetRecoveries(
  nodeIds: string[],
  now: Date,
): Promise<RecoveryTarget[]> {
  if (nodeIds.length === 0) return [];
  const rows = await prisma.executionTarget.findMany({
    where: {
      kind: "INSTANCE_MODEL",
      health: { in: ["DEGRADED", "UNHEALTHY"] },
      nextRetryAt: { lte: now },
      RuntimeModel: { type: "LLM", capabilities: { has: "TEXT_GENERATION" } },
      Instance: {
        OR: [
          { Runtime: { kind: "ALWAYS_ON", nodeId: { in: nodeIds } } },
          { Ranks: { some: { rank: 0, nodeId: { in: nodeIds }, claim: { not: "RELEASED" } } } },
        ],
      },
    },
    select: {
      id: true,
      RuntimeModel: { select: { upstreamModelId: true } },
      Instance: {
        select: {
          handle: true,
          Version: { select: { api: true } },
          Runtime: { select: { nodeId: true } },
          Ranks: { where: { rank: 0 }, select: { nodeId: true } },
        },
      },
    },
  });
  return rows.flatMap((row) => {
    const instance = row.Instance;
    const nodeId = instance?.Runtime.nodeId ?? instance?.Ranks[0]?.nodeId ?? null;
    if (!instance || !row.RuntimeModel || !nodeId || !instance.Version.api) return [];
    return [
      {
        id: row.id,
        nodeId,
        handle: instance.handle,
        upstreamModelId: row.RuntimeModel.upstreamModelId,
        api: instance.Version.api,
      },
    ];
  });
}

/** The smallest request that proves the instance answers (no reasoning, one token). */
export function recoveryProbe(target: RecoveryTarget): {
  family: "chat.completions" | "messages";
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
} {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  if (target.api === "ANTHROPIC") {
    return {
      family: "messages",
      path: "/v1/messages",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: encode({
        model: target.upstreamModelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    };
  }
  return {
    family: "chat.completions",
    path: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: encode({
      model: target.upstreamModelId,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  };
}
