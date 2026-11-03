/**
 * Runtime-definition sync (spec §4.3, contract "Chunked define"). The server never sends a diff
 * it cannot verify: every sync is a `complete` operation that `put`s the versions the node does
 * not report holding and `keep`s the rest, with the node part (port range, metric commands,
 * fabrics, command lifetime). After the final answer the node holds exactly the server's set,
 * and `Node.heldDefinitions` / held hashes are replaced from that answer.
 *
 * Which versions a node holds (cap `RUNTIME_DEFINITIONS_MAX`, in this priority):
 *   1. every version a process or step on the node may still name (never dropped): the launch
 *      version of every instance with a live claim on the node, what each live-claimed rank
 *      physically runs (a restart's earlier version, until its stop is proven), and the version
 *      of every unfinished step on the node;
 *   2. the current version of each server-origin ALWAYS_ON runtime on the node;
 *   3. versions pinned by profiles that own the node;
 *   4. the current version of every server-origin STARTABLE runtime of the owner (newest first).
 *
 * Nothing is sent to a node that is Relay only (or has a lowering pending): its set is frozen.
 * One operation per node is in flight; a sync asked for meanwhile runs after its final answer
 * (the per-node phases are {@link NodeSyncState}).
 */
import { randomBytes } from "node:crypto";
import { graphWrite } from "@ws-model-proxy/api/lib/graph-write";
import { requiredDefinitionsByNode } from "@ws-model-proxy/api/lib/node-definitions";
import {
  nodeFabricsHash,
  nodeMetricCommandsHash,
} from "@ws-model-proxy/api/lib/runtime-launch-hash";
import {
  metricCommandNeedsLaunch,
  type NodeMetricCommand,
  nodeMetricCommandsSchema,
  nodeRuntimeSpec,
  RUNTIME_DEFINITIONS_MAX,
  reportsLaunchFeatures,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { nodeFabricSets } from "@ws-model-proxy/api/nodes/fabrics";
import prisma, { type Prisma } from "@ws-model-proxy/db";
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

// ── What the node should hold (pure) ──

export type DesiredVersion = {
  envelope: DefinitionEnvelope;
  /** Lower is kept first under the cap. */
  priority: 1 | 2 | 3 | 4;
  /** Tie-break inside a priority (newest first). */
  createdAt: Date;
};

/**
 * Orders and caps the desired versions; the required ones (priority 1) always come first.
 * Admission keeps them within the cap (`definition_slots_full`); more than the cap of them is a
 * bug, logged, and the released CLI's limit still applies (the cap is never raised here).
 */
export function capDesired(
  versions: readonly DesiredVersion[],
  nodeId: string | null = null,
): DefinitionEnvelope[] {
  const byId = new Map<string, DesiredVersion>();
  for (const version of versions) {
    const seen = byId.get(version.envelope.versionId);
    if (!seen || version.priority < seen.priority) byId.set(version.envelope.versionId, version);
  }
  const required = [...byId.values()].filter((version) => version.priority === 1).length;
  if (required > RUNTIME_DEFINITIONS_MAX)
    console.error(
      "[runtime-sync] a node requires more definitions than it can hold; some are not sent",
      nodeId ?? "",
      required,
    );
  return (
    [...byId.values()]
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.envelope.versionId < b.envelope.versionId ? -1 : 1),
      )
      // Required versions sort first, so the cap drops only optional versions.
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
    // The node's copy: without the server-only `launch.reservations` (the launch hash too).
    spec: nodeRuntimeSpec(spec.data),
  };
}

const VERSION_SELECT = {
  id: true,
  createdAt: true,
  launchHash: true,
  spec: true,
  Runtime: { select: { id: true, slug: true, kind: true } },
} as const;

export async function loadNodeDefinitionState(
  nodeId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<NodeDefinitionState | null> {
  const node = await db.node.findUnique({
    where: { id: nodeId },
    select: {
      userId: true,
      trust: true,
      trustLowerRequestedAt: true,
      heldDefinitions: true,
      portStart: true,
      portEnd: true,
      metricCommands: true,
      features: true,
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
  const stored: NodeMetricCommand[] = metric.success ? metric.data : [];
  if (!metric.success) console.error("[runtime-sync] stored metric commands do not parse", nodeId);
  // A node without `features.launch` cannot parse an argv or a `shell` (`nodes.update` refuses
  // them for it; rows saved earlier, or a downgraded node, still reach here).
  const commands = reportsLaunchFeatures(node.features)
    ? stored
    : stored.filter((command) => !metricCommandNeedsLaunch(command));
  const sets = nodeFabricSets(node.FabricMembers);
  state.node = {
    portRange: [node.portStart, node.portEnd],
    metricCommands: { hash: nodeMetricCommandsHash(commands), commands },
    fabrics: { hash: nodeFabricsHash(sets), sets },
    commandMaxMs: node.commandMaxMs,
  };

  const userId = node.userId;
  // Every version a process or step on the node may still name (`node-definitions.ts`).
  const required =
    (await requiredDefinitionsByNode(db, { userId, nodeIds: [nodeId] })).get(nodeId) ??
    new Set<string>();
  const [needed, alwaysOn, pinned, startable] = await Promise.all([
    db.runtimeVersion.findMany({
      where: { id: { in: [...required] }, Runtime: { userId, origin: "SERVER" } },
      select: VERSION_SELECT,
    }),
    db.runtimeVersion.findMany({
      where: { CurrentOf: { userId, nodeId, kind: "ALWAYS_ON", origin: "SERVER" } },
      select: VERSION_SELECT,
    }),
    db.runtimeVersion.findMany({
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
    db.runtimeVersion.findMany({
      where: { CurrentOf: { userId, kind: "STARTABLE", origin: "SERVER" } },
      select: VERSION_SELECT,
      orderBy: { createdAt: "desc" },
      take: RUNTIME_DEFINITIONS_MAX,
    }),
  ]);
  const desired: DesiredVersion[] = [];
  const add = (rows: typeof needed, priority: DesiredVersion["priority"]) => {
    for (const row of rows) {
      const envelope = envelopeOf(row);
      if (envelope) desired.push({ envelope, priority, createdAt: row.createdAt });
    }
  };
  add(needed, 1);
  add(alwaysOn, 2);
  add(pinned, 3);
  add(startable, 4);
  state.desired = capDesired(desired, nodeId);
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

type Waiter = (outcome: DefineOutcome | null) => void;

/** One complete operation sent (or being built) for one session of a node. */
type Operation = {
  opId: string;
  /** The session the operation was sent to; answers and losses of other sessions are ignored. */
  connectionGeneration: number;
  /** The whole-operation deadline. */
  timer: ReturnType<typeof setTimeout>;
  results: Map<string, DefineEntryResult>;
  waiters: Waiter[];
};

/**
 * Where one node's definition sync is. A node with no entry is idle with no unanswered
 * operation. `unanswered` counts operations in a row the current session never answered (the
 * node expects a retry of the whole operation, at most {@link DEFINE_TIMEOUT_RETRIES} times).
 *
 *   idle ──sync──▶ building ──frames sent──▶ awaiting_answer ──final answer──▶ idle
 *   building | awaiting_answer ──sync──▶ (same, with `rerun` waiters: one more run afterwards)
 *   awaiting_answer ──deadline──▶ retry_backoff{timer} ──timer──▶ building (same session only)
 *   any ──disconnect of that session / new session──▶ idle (timers cancelled)
 */
type NodeSyncState =
  | { phase: "idle"; unanswered: number }
  | {
      phase: "building" | "awaiting_answer";
      op: Operation;
      unanswered: number;
      /** A sync asked for meanwhile: runs after this one, and these waiters get its answer. */
      rerun: Waiter[] | null;
    }
  | {
      phase: "retry_backoff";
      /** The session the retry is for: it is dropped if that session is gone. */
      connectionGeneration: number;
      timer: ReturnType<typeof setTimeout>;
      unanswered: number;
    };

type OperatingState = Extract<NodeSyncState, { phase: "building" | "awaiting_answer" }>;

function isOperating(state: NodeSyncState | undefined): state is OperatingState {
  return state?.phase === "building" || state?.phase === "awaiting_answer";
}

export type PushDefinitionsResult = Array<{
  nodeId: string;
  status: "applied" | "unchanged" | "rejected" | "pending" | "skipped_trust_relay";
  reason: string | null;
  detail?: string | null;
}>;

export function createRuntimeSync(
  relay: RuntimeSyncRelay,
  options: { operationTimeoutMs?: number; answerWaitMs?: number; retryBaseMs?: number } = {},
) {
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFINE_OPERATION_TIMEOUT_MS;
  const answerWaitMs = options.answerWaitMs ?? DEFINE_ANSWER_WAIT_MS;
  const nodes = new Map<string, NodeSyncState>();
  const retryBaseMs = options.retryBaseMs ?? DEFINE_RETRY_BASE_MS;

  const currentOp = (nodeId: string): Operation | null => {
    const state = nodes.get(nodeId);
    return isOperating(state) ? state.op : null;
  };

  const setIdle = (nodeId: string, unanswered: number) => {
    const state = nodes.get(nodeId);
    if (state?.phase === "retry_backoff") clearTimeout(state.timer);
    if (unanswered === 0) nodes.delete(nodeId);
    else nodes.set(nodeId, { phase: "idle", unanswered });
  };

  const resolveAll = (waiters: readonly Waiter[], outcome: DefineOutcome | null) => {
    for (const waiter of waiters) waiter(outcome);
  };

  /**
   * Ends exactly this operation (a no-op once another one owns the node's slot): its waiters get
   * `outcome`, and a rerun asked for meanwhile starts. `next` says what follows: the answer was
   * stored (`answered`), it timed out (`unanswered`), or it was cut short (`dropped`). With
   * `keepRerun: false` the rerun waiters are handed back instead of starting a run.
   */
  const finish = (
    nodeId: string,
    op: Operation,
    outcome: DefineOutcome | null,
    next: "answered" | "unanswered" | "dropped",
    keepRerun = true,
  ): Waiter[] => {
    const state = nodes.get(nodeId);
    if (!isOperating(state) || state.op !== op) return [];
    clearTimeout(op.timer);
    const rerun = state.rerun;
    const prior = state.unanswered;
    const unanswered =
      next === "answered"
        ? 0
        : next === "unanswered"
          ? Math.min(prior + 1, DEFINE_TIMEOUT_RETRIES)
          : prior;
    if (next === "unanswered" && prior < DEFINE_TIMEOUT_RETRIES && !(keepRerun && rerun)) {
      // A timed-out operation is sent again (same session, still Full control), with backoff.
      const connectionGeneration = op.connectionGeneration;
      const timer = setTimeout(
        () => {
          const current = nodes.get(nodeId);
          if (current?.phase !== "retry_backoff" || current.timer !== timer) return;
          const session = relay.nodeSession(nodeId);
          if (session?.connectionGeneration === connectionGeneration && session.trust === "full")
            void syncNode(nodeId);
          else setIdle(nodeId, current.unanswered);
        },
        retryBaseMs * 2 ** prior,
      );
      timer.unref?.();
      nodes.set(nodeId, { phase: "retry_backoff", connectionGeneration, timer, unanswered });
    } else {
      setIdle(nodeId, unanswered);
    }
    resolveAll(op.waiters, outcome);
    if (!rerun) return [];
    if (!keepRerun) return rerun;
    // The rerun is the retry a timeout asks for, too.
    void syncNode(nodeId, rerun);
    return [];
  };

  /**
   * Sends a complete operation to the node's current session (when it is online at Full
   * control). Resolves with the node's answer, or null (offline, Relay only, replaced, not
   * answered in time). Never rejects.
   */
  async function syncNode(
    nodeId: string,
    inherited: readonly Waiter[] = [],
  ): Promise<DefineOutcome | null> {
    const current = nodes.get(nodeId);
    if (isOperating(current)) {
      return new Promise((resolve) => {
        current.rerun = [...(current.rerun ?? []), ...inherited, resolve];
      });
    }
    const session = relay.nodeSession(nodeId);
    if (session?.trust !== "full") {
      resolveAll(inherited, null);
      return null;
    }
    // A pending retry is superseded by this run (it never stacks a second operation).
    if (current?.phase === "retry_backoff") clearTimeout(current.timer);
    // Counted per session: `nodeReady` resets it for a new one.
    const unanswered = current?.unanswered ?? 0;
    // Claim the slot before the first await so concurrent callers queue behind it.
    const op: Operation = {
      opId: `define-${randomBytes(9).toString("hex")}`,
      connectionGeneration: session.connectionGeneration,
      timer: setTimeout(() => finish(nodeId, op, null, "unanswered"), operationTimeoutMs),
      results: new Map(),
      waiters: [...inherited],
    };
    op.timer.unref?.();
    nodes.set(nodeId, { phase: "building", op, unanswered, rerun: null });
    const answer = new Promise<DefineOutcome | null>((resolve) => op.waiters.push(resolve));
    try {
      const owner = await prisma.node.findUnique({
        where: { id: nodeId },
        select: { userId: true },
      });
      if (!owner) {
        finish(nodeId, op, null, "dropped");
        return answer;
      }
      // Read and sent under the owner's fence, which every claim and step writer and every
      // admission takes: what the node requires is one coherent state, and an admission waits
      // until this operation's frames are on the socket (so nothing admitted after the read is
      // removed before the sync it triggers, which queues behind this one).
      await graphWrite([owner.userId], async (tx) => {
        const state = await loadNodeDefinitionState(nodeId, tx);
        // Replaced meanwhile (a new session took the slot): this operation is over.
        if (currentOp(nodeId) !== op) return;
        // The definitions are read under the node's owner (`loadNodeDefinitionState`); the live
        // session must be that owner's node too (defence in depth).
        if (
          !state?.fullControl ||
          state.userId !== owner.userId ||
          !nodeOwnerMatches(session, state.userId, "definition_sync")
        ) {
          finish(nodeId, op, null, "dropped");
          return;
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
            finish(nodeId, op, null, "dropped");
            return;
          }
        }
        const sending = nodes.get(nodeId);
        if (isOperating(sending) && sending.op === op) sending.phase = "awaiting_answer";
      });
    } catch (error) {
      console.error("[runtime-sync] building the definition sync failed", errorName(error));
      finish(nodeId, op, null, "dropped");
    }
    return answer;
  }

  const handleResult = async (ref: NodeSessionRef, frame: DefineResultFrame) => {
    const op = currentOp(ref.nodeId);
    if (!op || op.opId !== frame.opId || op.connectionGeneration !== ref.connectionGeneration)
      return;
    for (const result of frame.results) op.results.set(result.versionId, result);
    if (frame.node?.status === "rejected")
      console.warn("[runtime-sync] the node refused its node part", frame.node.reason ?? "");
    if (!frame.final) return;
    const held = frame.held ?? [];
    // A refused version is never held, so every complete operation puts it again and the node
    // refuses it again: the final answer's refusals replace the stored ones.
    const refusedDefinitions = [...op.results.values()].flatMap((result) =>
      result.status === "rejected"
        ? [
            {
              runtimeId: result.runtimeId,
              versionId: result.versionId,
              reason: result.reason ?? null,
              detail: result.detail ?? null,
            },
          ]
        : [],
    );
    // Status columns: no graph fence. A stale session's answer does not overwrite a newer one.
    let stored = false;
    try {
      const written = await prisma.node.updateMany({
        where: { id: ref.nodeId, connectionGeneration: ref.connectionGeneration },
        data: {
          heldDefinitions: held,
          refusedDefinitions,
          heldMetricCommandsHash: frame.heldMetricCommandsHash ?? null,
          heldFabricsHash: frame.heldFabricsHash ?? null,
        },
      });
      stored = written.count === 1;
    } catch (error) {
      console.error("[runtime-sync] storing the held set failed", errorName(error));
    }
    // An answer that was not stored keeps the unanswered count (as a dropped operation).
    finish(
      ref.nodeId,
      op,
      stored ? { results: op.results, held } : null,
      stored ? "answered" : "dropped",
    );
  };

  /** The session is gone: its operation ends, and so does a retry pending for it. */
  const finishForSession = (ref: NodeSessionRef) => {
    const state = nodes.get(ref.nodeId);
    if (isOperating(state) && state.op.connectionGeneration === ref.connectionGeneration) {
      resolveAll(finish(ref.nodeId, state.op, null, "dropped", false), null);
    } else if (
      state?.phase === "retry_backoff" &&
      state.connectionGeneration === ref.connectionGeneration
    ) {
      setIdle(ref.nodeId, state.unanswered);
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
      // A new session: an operation sent to an earlier one will never be answered, and a retry
      // pending for it is void. Syncs asked for meanwhile get the new session's answer.
      const state = nodes.get(ref.nodeId);
      let inherited: Waiter[] = [];
      if (isOperating(state) && state.op.connectionGeneration !== ref.connectionGeneration)
        inherited = finish(ref.nodeId, state.op, null, "dropped", false);
      const settled = nodes.get(ref.nodeId);
      // Its unanswered count belongs to the old session.
      if (!isOperating(settled)) setIdle(ref.nodeId, 0);
      else settled.unanswered = 0;
      if (ref.trust === "full") void syncNode(ref.nodeId, inherited);
      else resolveAll(inherited, null);
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
          return {
            nodeId: node.id,
            status: "rejected" as const,
            reason: entry.reason ?? null,
            detail: entry.detail ?? null,
          };
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
