/**
 * Runtime-definition sync (spec §4.3, contract "Chunked define"). The server never sends a diff
 * it cannot verify: every sync is a `complete` operation that `put`s the versions the node does
 * not report holding and `keep`s the rest, with the node part (port range, metric commands,
 * fabrics, command lifetime). After the final answer the node holds exactly the server's set,
 * and `Node.heldDefinitions` / held hashes are replaced from that answer.
 *
 * Which versions a node holds (cap `RUNTIME_DEFINITIONS_MAX`, in this priority):
 *   1. the launch version of every instance with a live claim on the node (never dropped);
 *   2. the current version of each server-origin ALWAYS_ON runtime on the node;
 *   3. versions pinned by profiles that own the node;
 *   4. the current version of every server-origin STARTABLE runtime of the owner (newest first).
 *
 * Nothing is sent to a node that is Relay only (or has a lowering pending): its set is frozen.
 * One operation per node is in flight; a sync asked for meanwhile runs after its final answer.
 */
import { randomBytes } from "node:crypto";
import {
  nodeFabricsHash,
  nodeMetricCommandsHash,
} from "@ws-model-proxy/api/lib/runtime-launch-hash";
import {
  type NodeMetricCommand,
  nodeMetricCommandsSchema,
  RUNTIME_DEFINITIONS_MAX,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { nodeFabricSets } from "@ws-model-proxy/api/nodes/fabrics";
import prisma from "@ws-model-proxy/db";
import {
  CHUNK_BUDGET_BYTES,
  DEFINE_CHUNK_MAX_VERSIONS,
  type DefinitionEnvelope,
  type HeldDefinition,
  heldDefinitionSchema,
  type NodeToServerControlFrame,
  type NodeTrustWire,
  type ServerToNodeControlFrame,
} from "./frames.js";
import { nodeOwnerMatches } from "./node-owner.js";
import type { NodeFrameHandlers, NodeSessionRef, SendGuard } from "./session-manager.js";

type DefineFrame = Extract<ServerToNodeControlFrame, { type: "runtime.define" }>;
type DefineNodePart = NonNullable<DefineFrame["node"]>;
type DefineResultFrame = Extract<NodeToServerControlFrame, { type: "runtime.define.result" }>;
type DefineEntryResult = DefineResultFrame["results"][number];

/** How long a whole define operation may take before the node is considered not to answer. */
export const DEFINE_OPERATION_TIMEOUT_MS = 60_000;
/** How long `pushRuntimeDefinitions` waits for node answers before reporting `pending`. */
export const DEFINE_ANSWER_WAIT_MS = 5_000;
/** Unanswered operations are retried this many times per session, backing off from 5 s. */
export const DEFINE_TIMEOUT_RETRIES = 3;
export const DEFINE_RETRY_BASE_MS = 5_000;

const LIVE_CLAIMS = ["HELD", "HELD_UNKNOWN"] as const;

// ── What the node should hold (pure) ──

export type DesiredVersion = {
  envelope: DefinitionEnvelope;
  /** Lower is kept first under the cap. */
  priority: 1 | 2 | 3 | 4;
  /** Tie-break inside a priority (newest first). */
  createdAt: Date;
};

/** Orders and caps the desired versions; launch versions of live instances always stay. */
export function capDesired(versions: readonly DesiredVersion[]): DefinitionEnvelope[] {
  const byId = new Map<string, DesiredVersion>();
  for (const version of versions) {
    const seen = byId.get(version.envelope.versionId);
    if (!seen || version.priority < seen.priority) byId.set(version.envelope.versionId, version);
  }
  return (
    [...byId.values()]
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.envelope.versionId < b.envelope.versionId ? -1 : 1),
      )
      // Live instances' launch versions sort first, so the cap drops only optional versions.
      .slice(0, RUNTIME_DEFINITIONS_MAX)
      .map((version) => version.envelope)
  );
}

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Splits one complete operation into frames: at most 64 versions per chunk and every chunk
 * within the byte budget; the node part rides on the first chunk.
 */
export function buildCompleteOperation(input: {
  opId: string;
  desired: readonly DefinitionEnvelope[];
  held: readonly HeldDefinition[];
  node: DefineNodePart | null;
}): DefineFrame[] {
  const heldHash = new Map(input.held.map((entry) => [entry.versionId, entry.launchHash]));
  const items: Array<{ put: DefinitionEnvelope } | { keep: string }> = input.desired.map(
    (envelope) =>
      heldHash.get(envelope.versionId) === envelope.launchHash
        ? { keep: envelope.versionId }
        : { put: envelope },
  );
  const frames: DefineFrame[] = [];
  let current: DefineFrame = {
    type: "runtime.define",
    opId: input.opId,
    chunkIndex: 0,
    final: false,
    complete: true,
    put: [],
    keep: [],
    ...(input.node ? { node: input.node } : {}),
  };
  const count = (frame: DefineFrame) => (frame.put?.length ?? 0) + (frame.keep?.length ?? 0);
  for (const item of items) {
    const candidate: DefineFrame = {
      ...current,
      put: "put" in item ? [...(current.put ?? []), item.put] : current.put,
      keep: "keep" in item ? [...(current.keep ?? []), item.keep] : current.keep,
    };
    const fits =
      count(candidate) <= DEFINE_CHUNK_MAX_VERSIONS &&
      encodedBytes({ ...candidate, final: true }) <= CHUNK_BUDGET_BYTES;
    // A lone envelope always fits a chunk of its own (RUNTIME_SPEC_MAX_BYTES), but not
    // necessarily beside the node part: then the node part goes alone.
    if (fits || (count(current) === 0 && !current.node)) {
      current = candidate;
      continue;
    }
    frames.push(current);
    current = {
      type: "runtime.define",
      opId: input.opId,
      chunkIndex: frames.length,
      final: false,
      complete: true,
      put: "put" in item ? [item.put] : [],
      keep: "keep" in item ? [item.keep] : [],
    };
  }
  frames.push(current);
  const last = frames.at(-1);
  if (last) last.final = true;
  return frames;
}

// ── Loading ──

type NodeDefinitionState = {
  userId: string;
  fullControl: boolean;
  held: HeldDefinition[];
  node: DefineNodePart | null;
  desired: DefinitionEnvelope[];
};

function envelopeOf(row: {
  id: string;
  launchHash: string;
  spec: unknown;
  Runtime: { id: string; slug: string; kind: "ALWAYS_ON" | "STARTABLE" };
}): DefinitionEnvelope | null {
  const spec = runtimeSpecSchema.safeParse(row.spec);
  if (!spec.success) {
    console.error("[runtime-sync] a stored version does not parse; it is not pushed", row.id);
    return null;
  }
  return {
    runtimeId: row.Runtime.id,
    versionId: row.id,
    launchHash: row.launchHash,
    kind: row.Runtime.kind === "ALWAYS_ON" ? "always_on" : "startable",
    slug: row.Runtime.slug,
    spec: spec.data,
  };
}

const VERSION_SELECT = {
  id: true,
  createdAt: true,
  launchHash: true,
  spec: true,
  Runtime: { select: { id: true, slug: true, kind: true } },
} as const;

export async function loadNodeDefinitionState(nodeId: string): Promise<NodeDefinitionState | null> {
  const node = await prisma.node.findUnique({
    where: { id: nodeId },
    select: {
      userId: true,
      trust: true,
      trustLowerRequestedAt: true,
      heldDefinitions: true,
      portStart: true,
      portEnd: true,
      metricCommands: true,
      commandMaxMs: true,
      FabricMembers: {
        select: {
          nodeId: true,
          ip: true,
          fabricId: true,
          Fabric: { select: { name: true, Members: { select: { ip: true } } } },
        },
      },
    },
  });
  if (!node) return null;
  const held = heldDefinitionSchema.array().safeParse(node.heldDefinitions);
  const fullControl = node.trust === "FULL" && node.trustLowerRequestedAt === null;
  const state: NodeDefinitionState = {
    userId: node.userId,
    fullControl,
    held: held.success ? held.data : [],
    node: null,
    desired: [],
  };
  if (!fullControl) return state;

  const metric = nodeMetricCommandsSchema.safeParse(node.metricCommands);
  const commands: NodeMetricCommand[] = metric.success ? metric.data : [];
  if (!metric.success) console.error("[runtime-sync] stored metric commands do not parse", nodeId);
  const sets = nodeFabricSets(node.FabricMembers);
  state.node = {
    portRange: [node.portStart, node.portEnd],
    metricCommands: { hash: nodeMetricCommandsHash(commands), commands },
    fabrics: { hash: nodeFabricsHash(sets), sets },
    commandMaxMs: node.commandMaxMs,
  };

  const userId = node.userId;
  const [running, alwaysOn, pinned, startable] = await Promise.all([
    prisma.runtimeVersion.findMany({
      where: {
        LaunchInstances: {
          some: { userId, Ranks: { some: { nodeId, claim: { in: [...LIVE_CLAIMS] } } } },
        },
        Runtime: { origin: "SERVER" },
      },
      select: VERSION_SELECT,
    }),
    prisma.runtimeVersion.findMany({
      where: { CurrentOf: { userId, nodeId, kind: "ALWAYS_ON", origin: "SERVER" } },
      select: VERSION_SELECT,
    }),
    prisma.runtimeVersion.findMany({
      where: {
        // An item pinned to other nodes does not use this node's cap.
        ProfileItems: {
          some: {
            Profile: { userId, Nodes: { some: { nodeId } } },
            OR: [{ nodeIds: { isEmpty: true } }, { nodeIds: { has: nodeId } }],
          },
        },
        Runtime: { userId, kind: "STARTABLE", origin: "SERVER" },
      },
      select: VERSION_SELECT,
    }),
    prisma.runtimeVersion.findMany({
      where: { CurrentOf: { userId, kind: "STARTABLE", origin: "SERVER" } },
      select: VERSION_SELECT,
      orderBy: { createdAt: "desc" },
      take: RUNTIME_DEFINITIONS_MAX,
    }),
  ]);
  const desired: DesiredVersion[] = [];
  const add = (rows: typeof running, priority: DesiredVersion["priority"]) => {
    for (const row of rows) {
      const envelope = envelopeOf(row);
      if (envelope) desired.push({ envelope, priority, createdAt: row.createdAt });
    }
  };
  add(running, 1);
  add(alwaysOn, 2);
  add(pinned, 3);
  add(startable, 4);
  state.desired = capDesired(desired);
  return state;
}

// ── The engine ──

export type RuntimeSyncRelay = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(
    nodeId: string,
  ): { userId: string; connectionGeneration: number; trust: NodeTrustWire } | null;
  getOnlineNodeIds(): string[];
};

export type DefineOutcome = {
  /** Per version answered in this operation. */
  results: Map<string, DefineEntryResult>;
  /** The node's whole held set after the operation. */
  held: HeldDefinition[];
};

type InFlight = {
  opId: string;
  /** The session the operation was sent to; answers and losses of other sessions are ignored. */
  connectionGeneration: number;
  timer: ReturnType<typeof setTimeout>;
  results: Map<string, DefineEntryResult>;
  waiters: Array<(outcome: DefineOutcome | null) => void>;
  again: boolean;
};

export type PushDefinitionsResult = Array<{
  nodeId: string;
  status: "applied" | "unchanged" | "rejected" | "pending" | "skipped_trust_relay";
  reason: string | null;
}>;

export function createRuntimeSync(
  relay: RuntimeSyncRelay,
  options: { operationTimeoutMs?: number; answerWaitMs?: number; retryBaseMs?: number } = {},
) {
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFINE_OPERATION_TIMEOUT_MS;
  const answerWaitMs = options.answerWaitMs ?? DEFINE_ANSWER_WAIT_MS;
  const inFlight = new Map<string, InFlight>();
  /** Later syncs asked for while one is in flight wait for the one that runs after it. */
  const queuedWaiters = new Map<string, Array<(outcome: DefineOutcome | null) => void>>();
  /** Unanswered operations in a row per node: the node expects a retry of the whole operation. */
  const timeouts = new Map<string, number>();

  /** A timed-out operation is sent again (same session, still Full control), with backoff. */
  const retryAfterTimeout = (nodeId: string, connectionGeneration: number) => {
    const count = timeouts.get(nodeId) ?? 0;
    if (count >= DEFINE_TIMEOUT_RETRIES) return;
    timeouts.set(nodeId, count + 1);
    const timer = setTimeout(
      () => {
        const session = relay.nodeSession(nodeId);
        if (session?.connectionGeneration === connectionGeneration && session.trust === "full")
          void syncNode(nodeId);
      },
      (options.retryBaseMs ?? DEFINE_RETRY_BASE_MS) * 2 ** count,
    );
    timer.unref?.();
  };

  const drainQueued = (nodeId: string) => {
    const queued = queuedWaiters.get(nodeId) ?? [];
    queuedWaiters.delete(nodeId);
    for (const waiter of queued) waiter(null);
  };

  /** Ends exactly this operation (a no-op once another one owns the node's slot). */
  const finish = (nodeId: string, op: InFlight, outcome: DefineOutcome | null) => {
    if (inFlight.get(nodeId) !== op) return;
    inFlight.delete(nodeId);
    clearTimeout(op.timer);
    for (const waiter of op.waiters) waiter(outcome);
    if (op.again) void syncNode(nodeId);
  };

  /**
   * Sends a complete operation to the node's current session (when it is online at Full
   * control). Resolves with the node's answer, or null (offline, Relay only, replaced, not
   * answered in time). Never rejects.
   */
  async function syncNode(nodeId: string): Promise<DefineOutcome | null> {
    const running = inFlight.get(nodeId);
    if (running) {
      running.again = true;
      return new Promise((resolve) => {
        const list = queuedWaiters.get(nodeId) ?? [];
        list.push(resolve);
        queuedWaiters.set(nodeId, list);
      });
    }
    const session = relay.nodeSession(nodeId);
    if (!session || session.trust !== "full") {
      drainQueued(nodeId);
      return null;
    }
    const waiters = queuedWaiters.get(nodeId) ?? [];
    queuedWaiters.delete(nodeId);
    // Claim the slot before the first await so concurrent callers queue behind it.
    const op: InFlight = {
      opId: `define-${randomBytes(9).toString("hex")}`,
      connectionGeneration: session.connectionGeneration,
      timer: setTimeout(() => {
        if (inFlight.get(nodeId) !== op) return;
        finish(nodeId, op, null);
        retryAfterTimeout(nodeId, op.connectionGeneration);
      }, operationTimeoutMs),
      results: new Map(),
      waiters,
      again: false,
    };
    op.timer.unref?.();
    inFlight.set(nodeId, op);
    const answer = new Promise<DefineOutcome | null>((resolve) => op.waiters.push(resolve));
    try {
      const state = await loadNodeDefinitionState(nodeId);
      // Replaced meanwhile (a new session took the slot): this operation is over.
      if (inFlight.get(nodeId) !== op) return answer;
      // The definitions are read under the node's owner (`loadNodeDefinitionState`); the live
      // session must be that owner's node too (defence in depth).
      if (!state?.fullControl || !nodeOwnerMatches(session, state.userId, "definition_sync")) {
        finish(nodeId, op, null);
        return answer;
      }
      const frames = buildCompleteOperation({
        opId: op.opId,
        desired: state.desired,
        held: state.held,
        node: state.node,
      });
      for (const frame of frames) {
        // Pinned to the planned session and re-checked against its live trust.
        const sent = relay.sendToNode(nodeId, frame, {
          connectionGeneration: op.connectionGeneration,
          requireFullTrust: true,
          userId: state.userId,
          ownerCheck: "definition_sync",
        });
        if (!sent) {
          finish(nodeId, op, null);
          break;
        }
      }
    } catch (error) {
      console.error("[runtime-sync] building the definition sync failed", errorName(error));
      finish(nodeId, op, null);
    }
    return answer;
  }

  const handleResult = async (ref: NodeSessionRef, frame: DefineResultFrame) => {
    const op = inFlight.get(ref.nodeId);
    if (!op || op.opId !== frame.opId || op.connectionGeneration !== ref.connectionGeneration)
      return;
    for (const result of frame.results) op.results.set(result.versionId, result);
    if (frame.node?.status === "rejected")
      console.warn("[runtime-sync] the node refused its node part", frame.node.reason ?? "");
    if (!frame.final) return;
    const held = frame.held ?? [];
    // Status columns: no graph fence. A stale session's answer does not overwrite a newer one.
    let stored = false;
    try {
      const written = await prisma.node.updateMany({
        where: { id: ref.nodeId, connectionGeneration: ref.connectionGeneration },
        data: {
          heldDefinitions: held,
          heldMetricCommandsHash: frame.heldMetricCommandsHash ?? null,
          heldFabricsHash: frame.heldFabricsHash ?? null,
        },
      });
      stored = written.count === 1;
    } catch (error) {
      console.error("[runtime-sync] storing the held set failed", errorName(error));
    }
    if (stored) timeouts.delete(ref.nodeId);
    finish(ref.nodeId, op, stored ? { results: op.results, held } : null);
  };

  /** Ends the node's operation if it was sent to this session. */
  const finishForSession = (ref: NodeSessionRef) => {
    const op = inFlight.get(ref.nodeId);
    if (op && op.connectionGeneration === ref.connectionGeneration) {
      op.again = false;
      finish(ref.nodeId, op, null);
      drainQueued(ref.nodeId);
    }
  };

  const handlers: Pick<
    NodeFrameHandlers,
    "definitionSync" | "nodeReady" | "nodeDisconnected" | "trustRaised" | "runtime.define.result"
  > = {
    // At Full control every hello is followed by one complete operation: the node's port range
    // is not stored, so the server cannot prove "nothing differs" without asking.
    definitionSync: async (ref) => (ref.trust === "full" ? "expect" : "none"),
    nodeReady: (ref) => {
      // A new session: an operation sent to an earlier one will never be answered.
      timeouts.delete(ref.nodeId);
      const stale = inFlight.get(ref.nodeId);
      if (stale && stale.connectionGeneration !== ref.connectionGeneration) {
        stale.again = false;
        finish(ref.nodeId, stale, null);
      }
      if (ref.trust === "full") void syncNode(ref.nodeId);
      else drainQueued(ref.nodeId);
    },
    nodeDisconnected: finishForSession,
    // Unfrozen: the server's current set replaces the frozen one.
    trustRaised: (ref) => void syncNode(ref.nodeId),
    "runtime.define.result": handleResult,
  };

  /** Online nodes of this owner (optionally only these). */
  async function onlineNodesOf(userId: string, only?: readonly string[]) {
    const online = relay.getOnlineNodeIds();
    const ids = only ? online.filter((id) => only.includes(id)) : online;
    if (ids.length === 0) return [];
    return prisma.node.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, trust: true, trustLowerRequestedAt: true },
    });
  }

  const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      timer.unref?.();
      void promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

  /** `Context.services.pushRuntimeDefinitions`: a runtime got a new version (or was removed). */
  async function pushRuntimeDefinitions(input: {
    userId: string;
    runtimeId: string;
  }): Promise<PushDefinitionsResult> {
    const runtime = await prisma.runtime.findFirst({
      where: { id: input.runtimeId, userId: input.userId },
      select: { kind: true, nodeId: true, currentVersionId: true, origin: true },
    });
    // A deleted runtime: every node of the owner drops it with its next complete operation.
    const nodes = await onlineNodesOf(
      input.userId,
      runtime?.kind === "ALWAYS_ON" && runtime.nodeId ? [runtime.nodeId] : undefined,
    );
    return Promise.all(
      nodes.map(async (node) => {
        if (node.trust !== "FULL" || node.trustLowerRequestedAt !== null)
          return { nodeId: node.id, status: "skipped_trust_relay" as const, reason: "trust_relay" };
        const outcome = await withDeadline(syncNode(node.id), answerWaitMs);
        if (outcome === "timeout" || outcome === null)
          return { nodeId: node.id, status: "pending" as const, reason: null };
        const versionId = runtime?.currentVersionId;
        const entry = versionId ? outcome.results.get(versionId) : undefined;
        if (entry?.status === "rejected")
          return { nodeId: node.id, status: "rejected" as const, reason: entry.reason ?? null };
        if (entry?.status === "applied")
          return { nodeId: node.id, status: "applied" as const, reason: null };
        return { nodeId: node.id, status: "unchanged" as const, reason: null };
      }),
    );
  }

  /** `services.nodes.definitionChanged`: the node part (or membership) of these nodes changed. */
  async function definitionChanged(nodeIds: readonly string[]): Promise<void> {
    const online = new Set(relay.getOnlineNodeIds());
    for (const nodeId of new Set(nodeIds)) if (online.has(nodeId)) void syncNode(nodeId);
  }

  return { handlers, syncNode, pushRuntimeDefinitions, definitionChanged };
}

function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}
