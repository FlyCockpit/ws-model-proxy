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
  targetDueWhere,
} from "@ws-model-proxy/api/lib/pool-routing";
import prisma from "@ws-model-proxy/db";
import { createSerialTask, type SerialTask } from "../serial-task.js";

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
  /** LLM: a one-token chat (or messages) request; EMBEDDINGS: a one-word embedding. */
  type: "LLM" | "EMBEDDINGS";
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

/**
 * Recovery passes on a {@link createSerialTask}: one at a time, every pass from a timer, a wake
 * during a pass (or a superseded probe) asks for one more right after it, and while this process
 * owns node sessions the next pass is due `idlePollMs` after the last one ends.
 */
export class TargetRecoveryScheduler {
  private readonly now: () => Date;
  private readonly task: SerialTask;

  constructor(private readonly dependencies: TargetRecoverySchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.task = createSerialTask({
      run: () => this.run(),
      // A transient database failure must not become an unhandled rejection; the next
      // bounded pass retries the scan.
      onError: () => undefined,
      // Every pass starts from a timer, never inside the caller (a node registration).
      minIntervalMs: 0,
      nextPassMs: () =>
        this.ownedNodeIds().length > 0
          ? (dependencies.idlePollMs ?? TARGET_RECOVERY_IDLE_POLL_MS)
          : null,
      timers: {
        setTimeout: (callback, ms) =>
          dependencies.setTimer ? dependencies.setTimer(callback, ms) : setTimeout(callback, ms),
        clearTimeout: (timer) =>
          dependencies.clearTimer ? dependencies.clearTimer(timer) : clearTimeout(timer),
      },
    });
  }

  /** Start or promptly rescan after a local node session is registered. */
  wake() {
    // With no owned node there is nothing to probe; a pending poll finds that and goes idle.
    if (this.ownedNodeIds().length === 0) return;
    void this.task.trigger();
  }

  stop() {
    void this.task.stop();
  }

  private ownedNodeIds(): string[] {
    return [...new Set(this.dependencies.getOwnedNodeIds())];
  }

  private owns(nodeId: string): boolean {
    return new Set(this.dependencies.getOwnedNodeIds()).has(nodeId);
  }

  private async run() {
    const ownedIds = this.ownedNodeIds();
    if (ownedIds.length === 0) return;
    const targets = await this.dependencies.listDueTargets(ownedIds, this.now());
    for (const target of targets) {
      // A session can be replaced after the query: never probe or write health for a target
      // whose socket this process no longer owns.
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
          // The result said nothing about the target: scan again right after this pass.
          if (healthy === "superseded") void this.task.trigger();
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
}

/**
 * Due targets on the owned nodes: unhealthy or degraded, retry time passed, served by an
 * instance whose head runs on one of the nodes, with a chat-capable LLM model or an OpenAI
 * embeddings model (transcription has no safe probe and is never turned into a transport
 * failure by recovery). Chat-capable is the model's effective capabilities: the owner's
 * override when set, else what the node detected (the override column alone is empty for
 * almost every model, which once kept recovery from ever probing anything).
 */
export async function listDueOwnedTargetRecoveries(
  nodeIds: string[],
  now: Date,
): Promise<RecoveryTarget[]> {
  if (nodeIds.length === 0) return [];
  const rows = await prisma.executionTarget.findMany({
    where: {
      kind: "INSTANCE_MODEL",
      // The same "due" rule the claim applies (`claimTargetRecoveryTrial`).
      ...targetDueWhere(now),
      RuntimeModel: {
        OR: [
          {
            type: "LLM",
            capabilitiesOverridden: false,
            detectedCapabilities: { has: "TEXT_GENERATION" },
          },
          { type: "LLM", capabilitiesOverridden: true, capabilities: { has: "TEXT_GENERATION" } },
          // A model saved before definitions stored their type's default has none; the node
          // serves it as its type (text generation for an LLM).
          { type: "LLM", capabilitiesOverridden: false, detectedCapabilities: { isEmpty: true } },
          { type: "EMBEDDINGS" },
        ],
      },
      Instance: {
        // Only a ready instance answers; a starting, stopping or failed one is not routed.
        phase: "READY",
        OR: [
          { Runtime: { kind: "ALWAYS_ON", nodeId: { in: nodeIds } } },
          { Ranks: { some: { rank: 0, nodeId: { in: nodeIds }, claim: { not: "RELEASED" } } } },
        ],
      },
    },
    select: {
      id: true,
      RuntimeModel: { select: { upstreamModelId: true, type: true } },
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
    const model = row.RuntimeModel;
    if (!instance || !model || !nodeId || !instance.Version.api) return [];
    if (model.type === "TRANSCRIPTION") return [];
    // An embeddings probe is an OpenAI request.
    if (model.type === "EMBEDDINGS" && instance.Version.api !== "OPENAI") return [];
    return [
      {
        id: row.id,
        nodeId,
        handle: instance.handle,
        upstreamModelId: model.upstreamModelId,
        api: instance.Version.api,
        type: model.type,
      },
    ];
  });
}

/** The smallest request that proves the instance answers (no reasoning, one token). */
export function recoveryProbe(target: RecoveryTarget): {
  family: "chat.completions" | "messages" | "embeddings";
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
} {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  if (target.type === "EMBEDDINGS") {
    return {
      family: "embeddings",
      path: "/v1/embeddings",
      headers: { "content-type": "application/json" },
      body: encode({ model: target.upstreamModelId, input: "ping" }),
    };
  }
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
