/**
 * Relay 3.0 node sessions: one authenticated websocket per node (`wsmp`), registered by its
 * signed `hello`, then carrying model requests, browser terminals, file ops, live
 * speech-to-text and telemetry.
 *
 * Public API (the server's other modules use only these):
 * - Socket lifecycle (./websocket.ts): `acceptAuthenticatedSocket`, `handleTextFrame`,
 *   `handleBinaryFrame`, `removeSession`.
 * - Routing: `getOnlineNodeIds()`, `getLiveNodeState(nodeId)`, `getLiveNodeTelemetry(nodeIds)`,
 *   `supportsCountContext(nodeId)`.
 * - Model requests (../model-api/relay-executor.ts): `registerRelayResponseHandlers`,
 *   `sendRelayRequest` (frame names the runtime `handle`), `cancelRelayRequest`,
 *   `completeRelayRequest`.
 * - Live speech-to-text (../model-api/realtime): `createSttSession`.
 * - Lanes: `setNodeFrameHandlers(handlers)` routes runtime.inventory / runtime.define.result /
 *   runtime.detected / runtime.job.result / secret.result / exec.* to their owners (A1/A2/A4/D3;
 *   the defaults log at debug and do nothing, an inventory is acknowledged);
 *   `sendToNode(nodeId, frame)` sends any server→node control frame to the live session;
 *   `requestTrustLower(nodeId, requestedAt)`; `setRelayAttemptStarter(start)` (recovery probes);
 *   `onPoolRoutingRulesChanged(poolId)`.
 * - Terminals (./terminal-websocket.ts): `registerTerminalBridge`, `startTerminal`,
 *   `attachTerminal`, `detachTerminalViewer`, `closeTerminalFromBrowser`,
 *   `forwardTerminalAuth`, `forwardBrowserSealed`,
 *   `listTerminalsForUser`, `terminalCounts`, `hasTerminal`, `releaseBrowserViewer`,
 *   `sweepExpiredPendingTerminals`, `notifyTerminalListChanged`.
 * - File ops (./node-file-ops.ts): `dispatchFileOp`, `dispatchFileCancel`, `forgetFileOp`.
 * - Revocation and shutdown: `closeSessionsForUser(userId)`,
 *   `closeSessionsForRevokedCredentials({ ids })`, `closeSessionsForNodes(nodeIds)`,
 *   `beginDrain`, `isDraining`, `closeIdleRelaySessions`, `closeRelaySessions`,
 *   `checkStaleSessions`, `dispose`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { evaluateEngineLoad } from "@ws-model-proxy/api/lib/engine-load";
import {
  ENDPOINT_LOAD_STALE_AFTER_MS,
  type NodeMetricsSample,
  parseNodeMetricsSample,
} from "@ws-model-proxy/api/lib/metric-routing";
import {
  disconnectNodeAtGeneration,
  markTargetsDueAfterNodeReconnect,
} from "@ws-model-proxy/api/lib/pool-routing";
import type { NodeFeatures } from "@ws-model-proxy/api/lib/runtime-spec";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import {
  persistAffinityCounterEpoch,
  readAffinityCounterEpoch,
} from "../model-api/cache-affinity-generation.js";
import {
  acknowledgeAffinityObservations,
  discoverAffinityObservers,
  observeAffinityReset,
  recoverAffinityObservers,
  registerAffinityObservers,
  renewAffinityObservers,
} from "../model-api/cache-affinity-observers.js";
import { beginAffinityReset } from "../model-api/cache-affinity-residency.js";
import { resetKvEvictionForInstance } from "../model-api/kv-eviction-feedback.js";
import type {
  FileOp,
  FileRejectDetail,
  FileRejectReason,
  FileResultFrame,
} from "./file-protocol.js";
import {
  type AlwaysOnInventory,
  type InstanceRecord,
  NODE_INFO_MIN_INTERVAL_MS,
  type NodeToServerControlFrame,
  type NodeTrustWire,
  RUNTIME_INVENTORY_CHUNK_MAX,
  RUNTIME_JOB_OPERATOR_STATUSES,
  type RuntimeJobFrame,
  type ServerToNodeControlFrame,
} from "./frames.js";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import { relayHelloOrigin, verifyHelloIdentitySignature } from "./hello-identity.js";
import {
  createRoutingEvaluationState,
  historyEngineFacts,
  MetricRoutingEvaluator,
  type RoutingEvaluationState,
  type RuntimeLoadReading,
} from "./metric-routing-evaluator.js";
import { type NodeAuditOutcome, recordNodeAuditEvent } from "./node-audit.js";
import type { NodeIdentity } from "./node-credential-auth.js";
import { observeNodeMetricsRollup } from "./node-metrics-rollup.js";
import { type NodeOwnerCheck, nodeOwnerMatches } from "./node-owner.js";
import {
  binaryFrameTarget,
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  helloNeedsUpgrade,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  protocolErrorMessage,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_SERVER_UPGRADE_REQUIRED_MESSAGE,
  RELAY_STALE_AFTER_MS,
  RELAY_UNREGISTERED_STALE_AFTER_MS,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
  type RelayFailure,
  type RelayProtocolErrorCode,
  type RelayResponseBodyMetadata,
  refusedRelayProtocolReason,
  rejectedHelloFacts,
  type ServerBinaryMetadata,
  type TerminalSealedMetadata,
} from "./protocol.js";
import {
  RelayRegistrationError,
  recordNodeIdentityRefusal,
  recordRejectedNodeHello,
  registerNodeHello,
  writeNodeHeartbeat,
  writeNodeState,
  writeNodeTelemetry,
} from "./registration.js";
import { observeRuntimeLoadRollup } from "./runtime-load-rollup.js";
import type { SttConfig } from "./stt-protocol.js";
import {
  type SttClientMessage,
  type SttCreateResult,
  SttRelayHub,
  type SttRelayLink,
  type SttSessionConsumer,
} from "./stt-relay.js";
import {
  listDueOwnedTargetRecoveries,
  type RecoveryTarget,
  recoveryProbe,
  TARGET_RECOVERY_PROBE_TIMEOUT_MS,
  TargetRecoveryScheduler,
} from "./target-recovery.js";

export { NODE_INFO_MIN_INTERVAL_MS };

const WS_READY_STATE_OPEN = 1;
/** Close code and reason for a socket closed because the server is shutting down. */
export const SHUTDOWN_CLOSE_CODE = 1001;
export const SHUTDOWN_CLOSE_REASON = "shutdown";

export type RelaySocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

type NodeFrame<T extends NodeToServerControlFrame["type"]> = Extract<
  NodeToServerControlFrame,
  { type: T }
>;
type ServerFrame<T extends ServerToNodeControlFrame["type"]> = Extract<
  ServerToNodeControlFrame,
  { type: T }
>;
type NodeMetricsFrame = NodeFrame<"node.metrics">;
type NodeInfoFrame = NodeFrame<"node.info">;
type RuntimeLoadFrame = NodeFrame<"runtime.load">;
type TerminalHandshakeIdentity = NonNullable<ServerFrame<"term.open">["identity"]>;
type TerminalIdentity = NonNullable<NodeFrame<"hello">["node"]["terminalIdentity"]>;

// Per-request outbound request-body stream. The server holds the remaining body chunks and
// only emits them while the node has granted credits, so a slow upstream on one request pauses
// that request's body flow without blocking sibling requests on the same socket.
type OutboundBodyStream = {
  chunks?: Uint8Array[];
  iterator?: AsyncIterator<Uint8Array>;
  nextChunkIndex: number;
  bytesSent: number;
  totalBytes: number;
  credits: number;
  pumping: boolean;
};

async function closeBodyStream(stream: OutboundBodyStream | undefined) {
  try {
    await stream?.iterator?.return?.();
  } catch {
    // The request is already terminal; cleanup is best-effort here.
  }
}

/** Why an in-flight file op ended without an answer from the node. */
export type FileOpLossCause = "node_offline" | "trust_relay" | "no_roots";

/** A file op the relay session routes node answers to (see `node-file-ops.ts`). */
export type TrackedFileOp = {
  opId: string;
  nodeId: string;
  /** The node owner the op was admitted for: only that owner's live session gets it. */
  userId: string;
  op: FileOp;
  markResult(frame: FileResultFrame): void;
  markData(body: Uint8Array): void;
  markRejected(reason: FileRejectReason, detail?: FileRejectDetail): void;
  /** The node sent a `file.*` frame for this op that failed the strict schema. */
  markMalformed(): void;
  markLost(cause: FileOpLossCause): void;
};

/** One browser tab's attachment to a terminal. `connId` is the browser socket. */
type TerminalViewer = { connId: string; attachedAt: number };
type TerminalPendingViewer = { connId: string; requestedAt: number };

/** A browser shell on a node (multi-viewer: every node frame names its viewer). */
export type TerminalRecord = {
  terminalId: string;
  userId: string;
  nodeId: string;
  cols: number;
  rows: number;
  /** Attached viewers by server-minted viewer id. */
  viewers: Map<string, TerminalViewer>;
  /** Viewers waiting for the node (approval, or term.opened / term.attached). */
  pendingViewers: Map<string, TerminalPendingViewer>;
  /** Reported by the node with term.writer. */
  writerViewerId: string | null;
  phase: "pending" | "opening" | "open";
  createdAt: number;
  /**
   * Set for the operator terminal of an interactive runtime step (spec §4.7): opened by the
   * node for a `runtime.job` this server sent, attached only by a ticket from
   * `runtimes.steps.attach`, allowed at Relay only too, never listed with the browser shells
   * and never counted against their limits. Null for a browser shell.
   */
  operator: OperatorTerminalInfo | null;
};

/** What the relay knows about an operator terminal (no command text). */
export type OperatorTerminalInfo = {
  stepId: string;
  instanceId: string;
  rank: number;
  /** `spawning` until `awaiting_operator`; `running` once the person pressed Enter. */
  state: "spawning" | "awaiting" | "running";
};

/**
 * One interactive step this session sent with an operator terminal, by step id, from the send
 * until its final result, `operator_closed`, a replacement or the session's end. It outlives
 * the terminal record: the node ends the terminal (`term.exit`) before its final result.
 */
type OperatorStepTracker = {
  stepId: string;
  instanceId: string;
  rank: number;
  phase: RuntimeJobFrame["phase"];
  intentHash: string;
  ownerEpoch: string;
  terminalId: string;
  userId: string;
  nodeId: string;
  state: OperatorTerminalInfo["state"];
  /** `operator_running` was seen for this terminal. */
  accepted: boolean;
  /** The server closed the terminal; only the node's answer to that close still routes. */
  cancelled: boolean;
};

/**
 * Interactive steps one session may track at once. The engine opens at most 4 operator
 * terminals of non-stop steps per node (stops are exempt); the node caps 8.
 */
export const OPERATOR_STEPS_PER_SESSION = 16;

export type TerminalWriterLabel = "you" | "other" | "none";

/** Events for the browser hub. `connId` / `connIds` name browser sockets. */
export type TerminalLifecycleEvent =
  | {
      type: "opened" | "attached" | "pending";
      terminalId: string;
      connId: string;
      viewerId: string;
      cliPublicKey: string;
      cliNonce: string;
      approvalCode?: string;
    }
  | {
      type: "rejected";
      terminalId: string;
      connId: string;
      reason: string;
      approvalCode?: string;
    }
  | {
      type: "exit";
      terminalId: string;
      connIds: string[];
      exitCode?: number;
      signal?: string;
    }
  | { type: "input_dropped"; terminalId: string; connId: string }
  | {
      type: "viewers";
      terminalId: string;
      count: number;
      recipients: Array<{ connId: string; writer: TerminalWriterLabel }>;
    }
  | {
      type: "sealed";
      terminalId: string;
      connIds: string[];
      seq: number;
      epoch?: number;
      body: Uint8Array;
    }
  /** This user's terminal list changed without a browser asking (a node came or went). */
  | { type: "list_changed"; userId: string };

type TerminalBridge = {
  onTerminalEvent(event: TerminalLifecycleEvent): void;
};

let terminalBridge: TerminalBridge | null = null;

export function registerTerminalBridge(bridge: TerminalBridge) {
  terminalBridge = bridge;
}

/**
 * Open browser terminals allowed per user and per node (`WMP_TERMINAL_USER_LIMIT`,
 * `WMP_TERMINAL_CLI_LIMIT`). The node also enforces its own `terminals.max` and refuses with
 * `limit`; the lowest limit wins.
 */
export function terminalLimits(): { user: number; node: number } {
  return { user: env.WMP_TERMINAL_USER_LIMIT, node: env.WMP_TERMINAL_CLI_LIMIT };
}

/** Whether one more browser terminal would exceed {@link terminalLimits}. */
export function terminalLimitReached(counts: { user: number; node: number }): boolean {
  const limits = terminalLimits();
  return counts.user >= limits.user || counts.node >= limits.node;
}

/** Attached viewers plus pending approvals per terminal. */
export const TERMINAL_VIEWER_LIMIT = 8;
const NODE_SEALED_BUFFER_LIMIT = 1024 * 1024;
const TERMINAL_PENDING_TTL_MS = 2 * 60 * 1000;
/**
 * `node.metrics` frames closer together than this are dropped. The node keeps them at least
 * 5 s apart; the margin absorbs network jitter.
 */
export const NODE_METRICS_MIN_INTERVAL_MS = 4_000;
/**
 * The Node row's snapshot of the latest metrics is written at most this often per node,
 * across sessions and server instances (the write is conditional on the stored
 * `nodeMetricsAt`), so reconnecting cannot reset the budget.
 */
export const NODE_METRICS_PERSIST_INTERVAL_MS = 60_000;
/** A dropped malformed telemetry frame is logged at most this often per session. */
const MALFORMED_TELEMETRY_LOG_INTERVAL_MS = 60_000;
const TELEMETRY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "node.info",
  "node.metrics",
  "runtime.load",
]);
/** Per handle/model key; the node sends every 2–5 s and on change. */
export const RUNTIME_LOAD_MIN_INTERVAL_MS = 1_000;
/** Distinct handle/model load keys kept per session. */
export const RUNTIME_LOAD_MAX_KEYS = 1_000;
/** KV-eviction reset (epoch change or prefixCacheReset) at most this often per instance. */
export const KV_EVICTION_RESET_DEBOUNCE_MS = 30_000;
/**
 * Bounds the per-instance epoch cache. A miss is never read as "unchanged": it costs one
 * durable epoch read, so this bounds memory, not correctness.
 */
export const KV_COUNTER_EPOCH_CACHE_MAX = 16_384;
/** handle → instance resolution cache (per node). */
const INSTANCE_CACHE_MAX = 16_384;
const INSTANCE_CACHE_HIT_TTL_MS = 30_000;
const INSTANCE_CACHE_MISS_TTL_MS = 5_000;
/** A chunked runtime.inventory snapshot must complete within this. */
export const RUNTIME_INVENTORY_SNAPSHOT_TIMEOUT_MS = 30_000;
/** Entries one inventory snapshot may carry across its chunks. */
export const RUNTIME_INVENTORY_SNAPSHOT_MAX_ENTRIES = 64 * RUNTIME_INVENTORY_CHUNK_MAX;

function addCapped(total: number, delta: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + delta);
}

function errorName(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

/** A live `runtime.load` reading, resolved to the instance it names. */
export type LiveRuntimeLoad = RuntimeLoadReading & {
  instanceId: string;
  counterEpoch: number;
};
type LiveRuntimeLoadEntry = LiveRuntimeLoad & { receivedAtMs: number };

/** What admission and the browser hub read about a connected node. */
export type LiveNodeState = {
  nodeId: string;
  userId: string;
  slug: string;
  protocolVersion: string;
  nodeVersion: string | null;
  /** As the server applies it: `relay` while a person's lowering is unconfirmed. */
  trust: NodeTrustWire;
  features: NodeFeatures;
  terminalPublicKey: string;
  terminalIdentity: TerminalIdentity | null;
  /** Handles of the node's last complete runtime inventory (always-on slugs, instance heads). */
  servedHandles: string[];
};

export type LiveNodeTelemetry = {
  nodeMetrics: Omit<NodeMetricsFrame, "type"> | null;
  nodeMetricsReceivedAt: Date | null;
  runtimeLoad: LiveRuntimeLoad[];
};

/** A registered node session, as handed to the lane handlers. */
export type NodeSessionRef = {
  nodeId: string;
  userId: string;
  slug: string;
  connectionGeneration: number;
  trust: NodeTrustWire;
};

export type RuntimeInventorySnapshot = {
  snapshotId: string;
  alwaysOn: AlwaysOnInventory[];
  instances: InstanceRecord[];
};

type RoutedNodeFrameType =
  | "runtime.define.result"
  | "runtime.detected"
  | "runtime.job.result"
  | "secret.result"
  | "exec.started"
  | "exec.status"
  | "exec.rejected";

/**
 * The lane-owned handling of node frames (A1/A2/A4/D3). Every handler is optional; a frame
 * without one is logged at debug level and dropped (an inventory is still acknowledged).
 * Handlers run after the frame passed the strict 3.0 schema and only for the session that
 * currently owns the node.
 */
export type NodeFrameHandlers = {
  /** Before `hello.ok`: whether a `runtime.define` diff follows (forced `none` at Relay). */
  definitionSync?(node: NodeSessionRef): Promise<"expect" | "none">;
  /** After `hello.ok` was sent (push definitions, metric commands, ...). */
  nodeReady?(node: NodeSessionRef): void | Promise<void>;
  /** The session that served the node went away (after the durable disconnect). */
  nodeDisconnected?(node: NodeSessionRef): void;
  /** The node reported Full control again (`wsmp trust full`): its definitions unfreeze. */
  trustRaised?(node: NodeSessionRef): void | Promise<void>;
  /** A complete inventory snapshot (A2). Its answer is the `runtime.inventory.ok/error` ack. */
  runtimeInventory?(
    node: NodeSessionRef,
    snapshot: RuntimeInventorySnapshot,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
} & {
  [K in RoutedNodeFrameType]?: (node: NodeSessionRef, frame: NodeFrame<K>) => void | Promise<void>;
};

/** Optional checks `sendToNode` makes against the live session before sending. */
export type SendGuard = {
  connectionGeneration?: number;
  requireFullTrust?: boolean;
  /**
   * The owner of what is sent (the command's, secret's, instance's or definitions' user): the
   * live session must be a node of that user, or nothing is sent (`node-owner.ts`).
   */
  userId?: string;
  /** The log class of an owner refusal (default `frame`). */
  ownerCheck?: NodeOwnerCheck;
};

/** How recovery probes reach a node (injected: model-api's relay attempt). */
export type RelayAttemptStarter = (input: {
  manager: RelaySessionManager;
  nodeId: string;
  handle: string;
  family: ServerFrame<"relay.request">["family"];
  method: "POST";
  path: string;
  headers: Headers;
  body: Uint8Array;
  timeoutMs: number;
}) => {
  started: Promise<{ status: number; body: ReadableStream<Uint8Array> }>;
  terminal: Promise<{ ok: boolean }>;
};

type InventoryAssembly = {
  snapshotId: string;
  nextIndex: number;
  alwaysOn: AlwaysOnInventory[];
  instances: InstanceRecord[];
  timer: ReturnType<typeof setTimeout>;
};

type SessionState = {
  socket: RelaySocket;
  identity: NodeIdentity;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  nodeId: string | null;
  slug: string | null;
  /**
   * The node's connection generation this session was accepted under. A disconnect write
   * presents it and is refused once the node has accepted a later connection.
   */
  connectionGeneration: number | null;
  registered: boolean;
  /** `hello.ok` was sent: lane frames (`sendToNode`) may follow; nothing but hello before. */
  helloAcked: boolean;
  protocolVersion: string | null;
  nodeVersion: string | null;
  trust: NodeTrustWire;
  features: NodeFeatures | null;
  terminalPublicKey: string | null;
  terminalIdentity: TerminalIdentity | null;
  servedHandles: Set<string>;
  inventory: InventoryAssembly | null;
  terminalsById: Map<string, TerminalRecord>;
  /** Interactive steps sent with an operator terminal, by step id. */
  operatorSteps: Map<string, OperatorStepTracker>;
  /** In-flight node file ops by op id (answers route only to the session that got the op). */
  filesById: Map<string, TrackedFileOp>;
  unauthenticatedTimer: ReturnType<typeof setTimeout>;
  /** One-shot nonce from `hello.challenge`; consumed when hello is verified. */
  helloNonce: string | null;
  bodyStreamsByRequest: Map<string, OutboundBodyStream>;
  nodeInfoAcceptedAtMs: number | null;
  nodeMetrics: {
    frame: Omit<NodeMetricsFrame, "type">;
    sample: NodeMetricsSample | null;
    receivedAt: Date;
  } | null;
  nodeMetricsAcceptedAtMs: number | null;
  nodeMetricsPersistedAtMs: number | null;
  runtimeLoad: Map<string, LiveRuntimeLoadEntry>;
  malformedTelemetryLoggedAtMs: number | null;
  malformedSttLoggedAtMs: number | null;
  routingEvaluation: RoutingEvaluationState | null;
};

export type ActiveRelayResponseHandlers = {
  /** Called only after request-body bytes have been accepted by the relay socket. */
  onRequestBodySent?(byteLength: number): void;
  /** Count-first Chat: the node reports tokenize before headers or a too-large error. */
  onCountResult?(message: CountContextResultMessage): void;
  onCountError?(message: CountContextErrorMessage): void;
  onHeaders(message: NodeFrame<"relay.response.headers">): void;
  onBody(chunk: Uint8Array, metadata: RelayResponseBodyMetadata): void;
  onComplete(message: NodeFrame<"relay.complete">): void;
  onError(message: NodeFrame<"relay.error">): void;
  onCancelled(message: NodeFrame<"relay.cancelled">): void;
};

export type CountContextResultMessage = NodeFrame<"context.count.result">;
export type CountContextErrorMessage = NodeFrame<"context.count.error">;

type ActiveRelayRequest = ActiveRelayResponseHandlers & { nodeId: string };

type ResolvedInstance = {
  instanceId: string;
  runtimeId: string;
  versionId: string;
  /** What the load history needs to judge FULL like the live verdict. */
  engine: {
    engine: string | null;
    kvFullThreshold: number | null;
    engineSlots: number | null;
    loadSignals: string[];
  };
};

function mintViewerId(terminal?: TerminalRecord): string {
  for (;;) {
    const viewerId = randomBytes(16).toString("base64url");
    if (!terminal || (!terminal.viewers.has(viewerId) && !terminal.pendingViewers.has(viewerId))) {
      return viewerId;
    }
  }
}

/** Distinct browser sockets that hold or wait for this terminal. */
function terminalConnIds(terminal: TerminalRecord): string[] {
  const connIds = new Set<string>();
  for (const viewer of terminal.viewers.values()) connIds.add(viewer.connId);
  for (const pending of terminal.pendingViewers.values()) connIds.add(pending.connId);
  return [...connIds];
}

/** The (terminal, browser socket) -> viewer ids lookup, derived from the viewer maps. */
function connViewerIds(terminal: TerminalRecord, connId: string): string[] {
  const viewerIds: string[] = [];
  for (const [viewerId, viewer] of terminal.viewers) {
    if (viewer.connId === connId) viewerIds.push(viewerId);
  }
  for (const [viewerId, pending] of terminal.pendingViewers) {
    if (pending.connId === connId) viewerIds.push(viewerId);
  }
  return viewerIds;
}

function attachedViewerIdForConn(terminal: TerminalRecord, connId: string): string | null {
  for (const [viewerId, viewer] of terminal.viewers) {
    if (viewer.connId === connId) return viewerId;
  }
  return null;
}

function pendingViewerIdForConn(terminal: TerminalRecord, connId: string): string | null {
  for (const [viewerId, pending] of terminal.pendingViewers) {
    if (pending.connId === connId) return viewerId;
  }
  return null;
}

function isSttClientMessage(message: NodeToServerControlFrame): message is SttClientMessage {
  return message.type.startsWith("stt.");
}

function closeCodeForProtocolError(code: RelayProtocolErrorCode): number {
  if (code === "access_denied" || code === "identity_mismatch") return 1008;
  if (code === "internal") return 1011;
  return 1002;
}

function closeWithProtocolError(
  socket: RelaySocket,
  code: RelayProtocolErrorCode,
  message: string,
  requestId?: string,
) {
  if (socket.readyState === WS_READY_STATE_OPEN) {
    try {
      socket.send(
        encodeRelayServerControlMessage(protocolErrorMessage({ code, message, requestId })),
      );
    } catch {
      // The close below still ends the socket.
    }
  }
  socket.close(closeCodeForProtocolError(code), code);
}

function protocolErrorFromRegistration(error: unknown): {
  code: RelayProtocolErrorCode;
  message: string;
} {
  if (error instanceof RelayRegistrationError) {
    if (error.code === "identity_mismatch")
      return { code: "identity_mismatch", message: error.message };
    if (error.code === "access_denied") return { code: "access_denied", message: error.message };
    return { code: "malformed", message: error.message };
  }
  return { code: "internal", message: "internal" };
}

/** The handles a complete inventory names: always-on slugs and instance heads that run. */
function servedHandlesOf(snapshot: RuntimeInventorySnapshot): Set<string> {
  const handles = new Set<string>();
  for (const entry of snapshot.alwaysOn) handles.add(entry.slug);
  for (const record of snapshot.instances) {
    if (record.rank === 0 && record.phase !== "stopped" && record.phase !== "stopping") {
      handles.add(record.handle);
    }
  }
  return handles;
}

function servedOnNodeWhere(nodeId: string) {
  return {
    OR: [
      { Runtime: { kind: "ALWAYS_ON" as const, nodeId } },
      { Ranks: { some: { rank: 0, nodeId, claim: { not: "RELEASED" as const } } } },
    ],
  };
}

export class RelaySessionManager {
  private readonly affinityObserverManagerId = randomUUID();
  private affinityObserverTimer: ReturnType<typeof setInterval> | undefined;
  private affinityObserverRunning: Promise<void> | undefined;
  private affinityObserverRecovery: Promise<void> | undefined;
  private pendingAffinityResets = new Map<
    string,
    {
      nodeId: string;
      connectionGeneration: number;
      handle: string;
      epoch: number;
      reset: boolean;
      /** The cached previous epoch was missing: compare against the durable epoch. */
      epochUnknown: boolean;
      /** A debounced explicit reset is delayed until here, never dropped. */
      notBefore: number;
      now: Date;
      version: number;
      release: () => void;
      running?: Promise<void>;
    }
  >();
  private affinityResetTimer: ReturnType<typeof setInterval> | undefined;
  private affinityResetRecoveryRunning = false;
  private affinityResetClosed = false;
  private affinityResetWrites = new Set<Promise<void>>();
  private sessionsBySocket = new Map<RelaySocket, SessionState>();
  private sessionsByNodeId = new Map<string, SessionState>();
  /** Last `counterEpoch` per (node, handle). Survives reconnect of this process. */
  private kvCounterEpochByInstance = new Map<string, number>();
  /** Last KV-eviction reset time per (node, handle), for debounce. */
  private kvResetAtByInstance = new Map<string, number>();
  /** (node, handle) → instance, bounded, short TTL (an instance restart keeps its handle). */
  private instanceByHandle = new Map<
    string,
    { value: ResolvedInstance | null; expiresAtMs: number }
  >();
  /**
   * Highest connection generation this process has installed or settled per node. Hello
   * results can complete out of order, so an older-committed hello may resume after a newer
   * one was detached and settled while no owner was installed; this remembers that the newer
   * generation exists so the older one is not installed over it. Bounded (oldest evicted).
   */
  private latestGenerationByNodeId = new Map<string, number>();
  private activeRelayRequests = new Map<string, ActiveRelayRequest>();
  private frameHandlers: NodeFrameHandlers = {};
  private relayAttemptStarter: RelayAttemptStarter | null = null;
  /**
   * Shutdown drain flag, shared by the relay and the browser terminal hub. Set by
   * {@link beginDrain} and again by {@link closeIdleRelaySessions} / {@link closeRelaySessions};
   * one-way. While set: new relay and browser terminal upgrades answer 503, no new model
   * request is sent, a node socket closes once its last model request finishes, and a socket
   * whose authentication finished after the drain began is closed on open.
   */
  private relayDrain = false;
  /** Live speech-to-text sessions; each registered node session is one link. */
  private readonly stt = new SttRelayHub({
    resolveLink: (nodeId, handle) => this.resolveSttLink(nodeId, handle),
    // During drain, the node socket closes once its last live session ended (deferred: the
    // hub is mid-operation when it calls this).
    onLinkIdle: (link) => {
      if (!this.relayDrain) return;
      queueMicrotask(() => this.considerDrainClose(link.nodeId));
    },
  });
  private readonly sttLinks = new WeakMap<SessionState, SttRelayLink>();
  private readonly routingEvaluator = new MetricRoutingEvaluator();
  private readonly targetRecovery = new TargetRecoveryScheduler({
    getOwnedNodeIds: () => this.getOnlineNodeIds(),
    listDueTargets: listDueOwnedTargetRecoveries,
    probe: (target) => this.probeTarget(target),
  });

  /** Lane handlers for node frames (see {@link NodeFrameHandlers}). Replaces the previous set. */
  setNodeFrameHandlers(handlers: NodeFrameHandlers) {
    this.frameHandlers = handlers;
  }

  /** The relay attempt recovery probes use (model-api's `startRelayAttempt`). */
  setRelayAttemptStarter(start: RelayAttemptStarter | null) {
    this.relayAttemptStarter = start;
  }

  /**
   * Sends one control frame to the node's live, registered session. False when there is none,
   * the server is draining, the socket is closing, or the frame fails the 3.0 contract (the
   * failure is logged by class; nothing is sent). `guard` pins the session the caller planned
   * for (its connection generation) and, for Full-control-only frames (`secret.*`,
   * `runtime.define`), the session's live trust: a lowering that landed meanwhile wins.
   */
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard: SendGuard = {}): boolean {
    if (this.relayDrain) return false;
    const session = this.sessionsByNodeId.get(nodeId);
    if (
      !session?.registered ||
      !session.helloAcked ||
      session.socket.readyState !== WS_READY_STATE_OPEN
    )
      return false;
    if (
      guard.connectionGeneration !== undefined &&
      session.connectionGeneration !== guard.connectionGeneration
    )
      return false;
    if (guard.requireFullTrust && session.trust !== "full") return false;
    if (
      // A guard that carries the key is checked even when its value is missing (refused then).
      Object.hasOwn(guard, "userId") &&
      !nodeOwnerMatches(
        { userId: session.identity.userId },
        guard.userId ?? "",
        guard.ownerCheck ?? "frame",
      )
    )
      return false;
    let encoded: string;
    try {
      encoded = encodeRelayServerControlMessage(frame);
    } catch (error) {
      console.error("[relay] refused to send a frame", frame.type, errorName(error));
      return false;
    }
    if (frame.type === "runtime.job" && frame.operator)
      return this.sendOperatorJob(session, frame, encoded);
    try {
      session.socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The live registered session of a node: its owner (the session's user), generation and
   * trust, or null when offline.
   */
  nodeSession(nodeId: string): {
    userId: string;
    connectionGeneration: number;
    trust: NodeTrustWire;
    operatorTerminals: boolean;
  } | null {
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session?.registered || !session.helloAcked || session.connectionGeneration === null)
      return null;
    return {
      userId: session.identity.userId,
      connectionGeneration: session.connectionGeneration,
      trust: session.trust,
      operatorTerminals: this.operatorTerminalsAllowed(session),
    };
  }

  // ── Operator terminals (interactive runtime steps, spec §4.7) ──

  /**
   * Operator terminals need the node's `operatorTerminals` feature and its terminal key; NOT
   * Full control (Relay-only nodes run them for their frozen definitions) and not the
   * browser-shell switch.
   */
  private operatorTerminalsAllowed(session: SessionState): boolean {
    return (
      session.registered &&
      session.features?.operatorTerminals === true &&
      session.terminalPublicKey !== null
    );
  }

  /** Whether the node's session can track one more operator terminal. */
  operatorRoom(nodeId: string): boolean {
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session) return false;
    return (
      session.operatorSteps.size < OPERATOR_STEPS_PER_SESSION ||
      [...session.operatorSteps.values()].some((tracker) => tracker.cancelled)
    );
  }

  /**
   * Send an interactive job and register its operator terminal (state `spawning`, attachable
   * once the node reports `awaiting_operator`). A repeated send of the same terminal for the
   * same dispatch re-sends the job only. A new terminal for a step replaces the old one (the
   * node closes it when it takes the new job). Terminal ids are never reused: an id held by
   * any other terminal refuses the send.
   */
  private sendOperatorJob(session: SessionState, job: RuntimeJobFrame, encoded: string): boolean {
    const operator = job.operator;
    const nodeId = session.nodeId;
    if (!operator || !nodeId || !this.operatorTerminalsAllowed(session)) return false;
    const terminalId = operator.terminalId;
    const previous = session.operatorSteps.get(job.stepId);
    const repeat =
      previous !== undefined &&
      !previous.cancelled &&
      previous.terminalId === terminalId &&
      previous.intentHash === job.intentHash &&
      previous.ownerEpoch === job.ownerEpoch &&
      previous.instanceId === job.instanceId &&
      previous.rank === job.rank &&
      session.terminalsById.get(terminalId)?.operator?.stepId === job.stepId;
    let evict: OperatorStepTracker | null = null;
    if (!repeat) {
      if (this.hasTerminal(terminalId) || this.operatorTerminalTracked(terminalId)) return false;
      if (previous === undefined && session.operatorSteps.size >= OPERATOR_STEPS_PER_SESSION) {
        evict = [...session.operatorSteps.values()].find((tracker) => tracker.cancelled) ?? null;
        if (evict === null) return false;
      }
    }
    try {
      session.socket.send(encoded);
    } catch {
      return false;
    }
    if (repeat) return true;
    if (evict !== null) session.operatorSteps.delete(evict.stepId);
    if (previous !== undefined) this.replaceOperatorStep(session, previous);
    session.operatorSteps.set(job.stepId, {
      stepId: job.stepId,
      instanceId: job.instanceId,
      rank: job.rank,
      phase: job.phase,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      terminalId,
      userId: session.identity.userId,
      nodeId,
      state: "spawning",
      accepted: false,
      cancelled: false,
    });
    session.terminalsById.set(terminalId, {
      terminalId,
      userId: session.identity.userId,
      nodeId,
      cols: 80,
      rows: 24,
      viewers: new Map(),
      pendingViewers: new Map(),
      writerViewerId: null,
      phase: "opening",
      createdAt: Date.now(),
      operator: {
        stepId: job.stepId,
        instanceId: job.instanceId,
        rank: job.rank,
        state: "spawning",
      },
    });
    return true;
  }

  private operatorTerminalTracked(terminalId: string): boolean {
    for (const session of this.sessionsByNodeId.values())
      for (const tracker of session.operatorSteps.values())
        if (tracker.terminalId === terminalId) return true;
    return false;
  }

  private auditOperator(
    tracker: OperatorStepTracker,
    outcome: NodeAuditOutcome,
    options: { actor?: "USER" | "SYSTEM"; exitCode?: number } = {},
  ) {
    const now = new Date();
    recordNodeAuditEvent({
      userId: tracker.userId,
      nodeId: tracker.nodeId,
      actor: options.actor ?? "SYSTEM",
      kind: "operator_terminal",
      subject: `step:${tracker.phase}`,
      instanceId: tracker.instanceId,
      stepId: tracker.stepId,
      rank: tracker.rank,
      ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
      outcome,
      startedAt: now,
      finishedAt: now,
    });
  }

  /**
   * A new terminal replaced this step's terminal: forget the old one, end its record and close
   * it on the node (a person's run in it, if any, is left alone there).
   */
  private replaceOperatorStep(session: SessionState, tracker: OperatorStepTracker) {
    if (session.operatorSteps.get(tracker.stepId) === tracker)
      session.operatorSteps.delete(tracker.stepId);
    if (tracker.state !== "spawning" && !tracker.cancelled) this.auditOperator(tracker, "closed");
    const terminal = session.terminalsById.get(tracker.terminalId);
    if (terminal?.operator) this.closeTerminal(session, terminal, true);
    else if (!tracker.cancelled)
      this.sendControl(session, { type: "term.close", terminalId: tracker.terminalId });
  }

  /**
   * Operator progress and finals of a tracked interactive step, before the lifecycle engine
   * sees them. Progress passes on only when it names exactly the terminal this session sent
   * for that dispatch (id, intent hash, owner epoch, instance, rank); a live terminal nobody
   * tracks is closed on the node. Finals always pass on (the engine checks the stored
   * terminal id). Writes the audit rows. Returns whether the result goes on to the engine.
   */
  private observeOperatorResult(
    session: SessionState,
    result: NodeFrame<"runtime.job.result">,
  ): boolean {
    const progress = (RUNTIME_JOB_OPERATOR_STATUSES as readonly string[]).includes(result.status);
    const terminalId = result.terminalId;
    if (terminalId === undefined) return !progress;
    const tracker = session.operatorSteps.get(result.stepId);
    const matches =
      tracker !== undefined &&
      tracker.terminalId === terminalId &&
      tracker.intentHash === result.intentHash &&
      tracker.ownerEpoch === result.ownerEpoch &&
      tracker.instanceId === result.instanceId &&
      tracker.rank === result.rank;
    if (!matches || tracker === undefined) {
      // A terminal this session no longer tracks (replaced, or never sent) must not stay open
      // on the node. Only this session's state is consulted.
      if (
        progress &&
        result.status !== "operator_closed" &&
        !session.terminalsById.has(terminalId) &&
        ![...session.operatorSteps.values()].some((other) => other.terminalId === terminalId)
      )
        this.sendControl(session, { type: "term.close", terminalId });
      return !progress;
    }
    const record = session.terminalsById.get(terminalId);
    const terminal = record?.operator ? record : undefined;
    if (tracker.cancelled) {
      // Only the node's answer to the server's own close still matters. A screen that came up
      // after the close is closed again; a run that won the race is left to finish on the node.
      if (result.status === "awaiting_operator") {
        this.sendControl(session, { type: "term.close", terminalId });
        return false;
      }
      if (result.status === "operator_running") return false;
      if (result.status === "running") return true;
      session.operatorSteps.delete(tracker.stepId);
      return true;
    }
    switch (result.status) {
      case "awaiting_operator": {
        if (tracker.state === "spawning") this.auditOperator(tracker, "opened");
        // The node shows the confirm screen once per terminal; a repeat re-reports it.
        if (tracker.state === "running") return false;
        tracker.state = "awaiting";
        if (terminal?.operator) {
          terminal.phase = "open";
          terminal.operator.state = "awaiting";
        }
        return true;
      }
      case "operator_running": {
        if (tracker.state === "spawning") return false;
        if (tracker.state === "awaiting")
          this.auditOperator(tracker, "accepted", { actor: "USER" });
        tracker.state = "running";
        tracker.accepted = true;
        if (terminal?.operator) terminal.operator.state = "running";
        return true;
      }
      case "operator_closed": {
        session.operatorSteps.delete(tracker.stepId);
        if (tracker.state !== "spawning") {
          if (result.exitCode !== undefined || tracker.accepted)
            this.auditOperator(tracker, "closed", {
              ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            });
          else this.auditOperator(tracker, "declined", { actor: "USER" });
        }
        if (terminal) this.closeTerminal(session, terminal, false);
        return true;
      }
      case "running":
        return true;
      default: {
        session.operatorSteps.delete(tracker.stepId);
        const outcome: NodeAuditOutcome =
          result.status === "succeeded"
            ? tracker.accepted
              ? "completed"
              : "auto_settled"
            : tracker.state === "spawning"
              ? "refused"
              : "failed";
        this.auditOperator(tracker, outcome);
        // The node ends the terminal before its final answer; a record still here is stale.
        if (terminal) this.closeTerminal(session, terminal, true);
        return true;
      }
    }
  }

  /**
   * Close the operator terminal of a step by step id, on whichever session holds it.
   * `keepRunning` leaves a terminal whose command already runs alone (answer `running`): a
   * person's run is never cut off. The node's `operator_closed` still reaches the engine.
   */
  closeOperatorStep(
    stepId: string,
    options: { keepRunning?: boolean; actor?: "USER" | "SYSTEM" } = {},
  ): "closed" | "running" | "absent" {
    for (const session of this.sessionsByNodeId.values()) {
      const tracker = session.operatorSteps.get(stepId);
      if (tracker === undefined || tracker.cancelled) continue;
      if (options.keepRunning === true && tracker.state === "running") return "running";
      this.cancelOperatorStep(session, tracker, options.actor ?? "SYSTEM");
      return "closed";
    }
    return "absent";
  }

  /**
   * Close an operator terminal no step owns any more (the engine dropped an answer naming it):
   * its tracker is cancelled, or the node is told directly when nothing tracks it.
   */
  closeOperatorTerminal(nodeId: string, terminalId: string) {
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session) return;
    const tracker = [...session.operatorSteps.values()].find(
      (candidate) => candidate.terminalId === terminalId,
    );
    if (tracker) {
      if (!tracker.cancelled) this.cancelOperatorStep(session, tracker, "SYSTEM");
      return;
    }
    const terminal = session.terminalsById.get(terminalId);
    if (terminal?.operator) this.closeTerminal(session, terminal, true);
    else if (!terminal) this.sendControl(session, { type: "term.close", terminalId });
  }

  /** Ban fence: close every operator terminal of this user. */
  cancelOperatorTerminalsForUser(userId: string) {
    for (const session of this.sessionsByNodeId.values()) {
      if (session.identity.userId !== userId) continue;
      for (const tracker of [...session.operatorSteps.values()])
        if (!tracker.cancelled) this.cancelOperatorStep(session, tracker, "SYSTEM");
    }
  }

  private cancelOperatorStep(
    session: SessionState,
    tracker: OperatorStepTracker,
    actor: "USER" | "SYSTEM",
  ) {
    if (tracker.state !== "spawning") this.auditOperator(tracker, "cancelled", { actor });
    tracker.cancelled = true;
    const terminal = session.terminalsById.get(tracker.terminalId);
    if (terminal?.operator) this.closeTerminal(session, terminal, true);
    else this.sendControl(session, { type: "term.close", terminalId: tracker.terminalId });
  }

  /**
   * The open operator terminal of a step the user owns, waiting for its person: what an attach
   * ticket is bound to. Null while it is not attachable (spawning, closed, ended, cancelled,
   * or the node can no longer hold operator terminals).
   */
  operatorStepTerminal(
    stepId: string,
    userId: string,
  ): { nodeId: string; terminalId: string; state: "awaiting" | "running" } | null {
    for (const session of this.sessionsByNodeId.values()) {
      const tracker = session.operatorSteps.get(stepId);
      if (!tracker || tracker.cancelled || tracker.userId !== userId) continue;
      // The node holding the terminal is the step owner's (defence in depth).
      if (!nodeOwnerMatches({ userId: session.identity.userId }, userId, "operator_attach"))
        return null;
      if (!this.operatorTerminalsAllowed(session) || this.relayDrain) return null;
      const terminal = session.terminalsById.get(tracker.terminalId);
      if (!terminal?.operator || terminal.phase !== "open" || terminal.userId !== userId)
        return null;
      if (terminal.operator.state === "spawning") return null;
      return {
        nodeId: terminal.nodeId,
        terminalId: terminal.terminalId,
        state: terminal.operator.state,
      };
    }
    return null;
  }

  /** A person lowered the node's trust: tell its live session (the node answers `node.state`). */
  requestTrustLower(nodeId: string, requestedAt: Date): boolean {
    const session = this.sessionsByNodeId.get(nodeId);
    if (session) session.trust = "relay";
    if (session) this.reconcileTrust(session);
    return this.sendToNode(nodeId, {
      type: "trust.lower",
      id: `trust-${randomBytes(8).toString("hex")}`,
      requestedAt: requestedAt.toISOString(),
    });
  }

  /**
   * Registers an upgraded, authenticated node socket. The single admission point for the
   * drain: a socket whose authentication finished after the drain began is closed with the
   * shutdown close code and never registered. Returns whether it was accepted.
   */
  acceptAuthenticatedSocket({
    socket,
    identity,
    now = new Date(),
  }: {
    socket: RelaySocket;
    identity: NodeIdentity;
    now?: Date;
  }): boolean {
    if (this.relayDrain) {
      if (socket.readyState === WS_READY_STATE_OPEN) {
        socket.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
      }
      return false;
    }
    const helloNonce = randomBytes(16).toString("base64url");
    const unauthenticatedTimer = setTimeout(() => {
      const session = this.sessionsBySocket.get(socket);
      if (!session?.registered) {
        closeWithProtocolError(socket, "malformed", "Registration was not received in time.");
        void this.removeSession(socket, new Date());
      }
    }, RELAY_UNREGISTERED_STALE_AFTER_MS);
    unauthenticatedTimer.unref?.();

    this.sessionsBySocket.set(socket, {
      socket,
      identity,
      connectedAt: now,
      lastHeartbeatAt: now,
      nodeId: null,
      slug: null,
      connectionGeneration: null,
      registered: false,
      helloAcked: false,
      protocolVersion: null,
      nodeVersion: null,
      trust: "relay",
      features: null,
      terminalPublicKey: null,
      terminalIdentity: null,
      servedHandles: new Set(),
      inventory: null,
      terminalsById: new Map(),
      operatorSteps: new Map(),
      filesById: new Map(),
      unauthenticatedTimer,
      helloNonce,
      bodyStreamsByRequest: new Map(),
      nodeInfoAcceptedAtMs: null,
      nodeMetrics: null,
      nodeMetricsAcceptedAtMs: null,
      nodeMetricsPersistedAtMs: null,
      runtimeLoad: new Map(),
      malformedTelemetryLoggedAtMs: null,
      malformedSttLoggedAtMs: null,
      routingEvaluation: null,
    });
    if (socket.readyState === WS_READY_STATE_OPEN) {
      socket.send(
        encodeRelayServerControlMessage({
          type: "hello.challenge",
          nonce: helloNonce,
          origin: relayHelloOrigin(),
        }),
      );
    }
    return true;
  }

  private sessionRef(session: SessionState): NodeSessionRef | null {
    if (!session.registered || !session.nodeId || !session.slug) return null;
    if (session.connectionGeneration === null) return null;
    return {
      nodeId: session.nodeId,
      userId: session.identity.userId,
      slug: session.slug,
      connectionGeneration: session.connectionGeneration,
      trust: session.trust,
    };
  }

  /** The session currently serving its node (not replaced, not detached). */
  private isCurrent(session: SessionState): boolean {
    return (
      this.sessionsBySocket.get(session.socket) === session &&
      !!session.nodeId &&
      this.sessionsByNodeId.get(session.nodeId) === session
    );
  }

  async handleTextFrame(socket: RelaySocket, frame: string, now = new Date()) {
    const session = this.sessionsBySocket.get(socket);
    if (!session) return;
    // A hello that is not 3.0 gets a message it can print (an "upgrade wsmp" text), not an
    // opaque schema rejection.
    if (!session.registered && helloNeedsUpgrade(frame)) {
      const rejected = rejectedHelloFacts(frame);
      const reason = refusedRelayProtocolReason(rejected.protocolVersion);
      const code = reason === "cli_too_new" ? "upgrade_server" : "upgrade_cli";
      console.error("[relay] refused a hello this server does not speak", { ...rejected, code });
      closeWithProtocolError(
        socket,
        code,
        code === "upgrade_server"
          ? RELAY_SERVER_UPGRADE_REQUIRED_MESSAGE
          : RELAY_UPGRADE_REQUIRED_MESSAGE,
      );
      await recordRejectedNodeHello(session.identity, rejected, now).catch((error: unknown) => {
        console.error("[relay] recording a refused hello failed", errorName(error));
      });
      await this.removeSession(socket, now);
      return;
    }
    let message: NodeToServerControlFrame;
    try {
      message = parseRelayClientControlFrame(frame);
    } catch (error) {
      if (this.isolateMalformedInteractiveFrame(session, frame)) return;
      const description = describeRelayControlParseError(error);
      if (description.kind === "oversize") {
        console.error("[relay] control frame exceeds 64 KiB");
      } else if (description.kind === "json") {
        console.error("[relay] control frame is not JSON");
      } else if (description.kind === "schema") {
        console.error("[relay] control frame schema rejected", description.issues);
      } else {
        console.error("[relay] control frame parse failed", description.name);
      }
      closeWithProtocolError(socket, "malformed", "Malformed relay protocol message.");
      await this.removeSession(socket, now);
      return;
    }

    if (message.type === "hello") {
      await this.handleHello(session, message, now);
      return;
    }

    if (!session.registered || !session.nodeId) {
      closeWithProtocolError(
        socket,
        "malformed",
        "Registration is required before relay messages.",
      );
      await this.removeSession(socket, now);
      return;
    }

    switch (message.type) {
      case "heartbeat": {
        session.lastHeartbeatAt = now;
        // Same durable fence as the disconnect: only while the row still describes THIS
        // session's connection.
        await writeNodeHeartbeat(session.nodeId, session.connectionGeneration, now).catch(
          (error: unknown) => console.error("[relay] heartbeat write failed", errorName(error)),
        );
        this.sendControl(session, {
          type: "heartbeat.pong",
          id: message.id,
          receivedAt: now.toISOString(),
        });
        return;
      }
      case "node.state":
        await this.handleNodeState(session, message, now);
        return;
      case "runtime.inventory":
        await this.handleInventoryChunk(session, message);
        return;
      case "runtime.load":
        await this.handleRuntimeLoad(session, message, now);
        return;
      case "node.info":
      case "node.metrics":
        await this.handleTelemetry(session, message, now);
        return;
      case "relay.request.body.ack":
        this.grantBodyCredits(session, message.requestId, message.credits);
        return;
      case "relay.response.headers":
        this.ownedRelayRequest(session, message.requestId)?.onHeaders(message);
        return;
      case "relay.complete": {
        const active = this.takeOwnedRelayRequest(session, message.requestId);
        if (!active) return;
        active.onComplete(message);
        this.considerDrainClose(active.nodeId);
        return;
      }
      case "relay.error": {
        const active = this.takeOwnedRelayRequest(session, message.requestId);
        if (!active) return;
        active.onError(message);
        this.considerDrainClose(active.nodeId);
        return;
      }
      case "relay.cancelled": {
        const active = this.takeOwnedRelayRequest(session, message.requestId);
        if (!active) return;
        active.onCancelled(message);
        this.considerDrainClose(active.nodeId);
        return;
      }
      case "context.count.result":
        this.ownedRelayRequest(session, message.requestId)?.onCountResult?.(message);
        return;
      case "context.count.error":
        this.ownedRelayRequest(session, message.requestId)?.onCountError?.(message);
        return;
      case "term.pending":
      case "term.opened":
      case "term.attached":
      case "term.rejected":
      case "term.writer":
      case "term.input_dropped":
      case "term.exit":
        this.handleTerminalControl(session, message);
        return;
      case "file.result":
        session.filesById.get(message.opId)?.markResult(message);
        return;
      case "file.rejected":
        session.filesById.get(message.opId)?.markRejected(message.reason, message.detail);
        return;
      case "runtime.job.result":
        if (!this.isCurrent(session) || !this.observeOperatorResult(session, message)) return;
        await this.routeToHandler(session, message);
        return;
      case "runtime.define.result":
      case "runtime.detected":
      case "secret.result":
      case "exec.started":
      case "exec.status":
      case "exec.rejected":
        await this.routeToHandler(session, message);
        return;
      default:
        // Live speech-to-text. Frames for sessions this node does not hold are dropped.
        if (isSttClientMessage(message)) {
          this.stt.handleClientFrame(this.sttLinkFor(session), message);
        }
    }
  }

  private async routeToHandler(
    session: SessionState,
    message: NodeFrame<RoutedNodeFrameType>,
  ): Promise<void> {
    const ref = this.sessionRef(session);
    if (!ref || !this.isCurrent(session)) return;
    const handlers = this.frameHandlers;
    try {
      switch (message.type) {
        case "runtime.define.result":
          if (handlers["runtime.define.result"])
            return await handlers["runtime.define.result"](ref, message);
          break;
        case "runtime.detected":
          if (handlers["runtime.detected"]) return await handlers["runtime.detected"](ref, message);
          break;
        case "runtime.job.result":
          if (handlers["runtime.job.result"])
            return await handlers["runtime.job.result"](ref, message);
          break;
        case "secret.result":
          if (handlers["secret.result"]) return await handlers["secret.result"](ref, message);
          break;
        case "exec.started":
          if (handlers["exec.started"]) return await handlers["exec.started"](ref, message);
          break;
        case "exec.status":
          if (handlers["exec.status"]) return await handlers["exec.status"](ref, message);
          break;
        case "exec.rejected":
          if (handlers["exec.rejected"]) return await handlers["exec.rejected"](ref, message);
          break;
      }
    } catch (error) {
      console.error("[relay] node frame handler failed", message.type, errorName(error));
      return;
    }
    console.debug("[relay] node frame without a handler", message.type);
  }

  private async handleHello(session: SessionState, message: NodeFrame<"hello">, now: Date) {
    const socket = session.socket;
    if (session.registered) {
      closeWithProtocolError(socket, "malformed", "Hello was already received.");
      await this.removeSession(socket, now);
      return;
    }
    const nonce = session.helloNonce;
    session.helloNonce = null;
    if (
      !nonce ||
      !verifyHelloIdentitySignature({
        identityPublicKey: message.node.identityPublicKey,
        signature: message.node.identitySignature,
        nonce,
        nodeSlug: message.node.slug,
        origin: relayHelloOrigin(),
      })
    ) {
      closeWithProtocolError(socket, "malformed", "Hello identity proof is invalid.");
      await this.removeSession(socket, now);
      return;
    }
    let registration: Awaited<ReturnType<typeof registerNodeHello>>;
    try {
      registration = await registerNodeHello({
        identity: session.identity,
        hello: {
          slug: message.node.slug,
          hostname: message.node.hostname,
          version: message.node.version,
          identityPublicKey: message.node.identityPublicKey,
          trust: message.trust.value,
          features: message.features,
          definitions: message.definitions,
          heldMetricCommandsHash: message.heldMetricCommandsHash,
          heldFabricsHash: message.heldFabricsHash,
        },
        protocolVersion: message.protocolVersion,
        now,
      });
    } catch (error) {
      // Already detached and closed by whoever detached it.
      if (this.sessionsBySocket.get(socket) !== session) return;
      if (error instanceof RelayRegistrationError && error.code === "identity_mismatch") {
        await recordNodeIdentityRefusal(session.identity, "identity_mismatch", now).catch(
          (refusalError: unknown) =>
            console.error("[relay] recording an identity refusal failed", errorName(refusalError)),
        );
      } else if (!(error instanceof RelayRegistrationError)) {
        console.error("[relay] node registration failed", errorName(error));
      }
      const mapped = protocolErrorFromRegistration(error);
      closeWithProtocolError(socket, mapped.code, mapped.message, message.id);
      await this.removeSession(socket, now);
      return;
    }
    if (this.sessionsBySocket.get(socket) !== session) {
      // Detached while registration ran (socket closed, or its credential revoked). The
      // registration committed ONLINE for a session that no longer exists: put the node back
      // unless another live session owns it.
      await this.settleDetachedRegistration(
        registration.nodeId,
        now,
        registration.connectionGeneration,
      );
      return;
    }
    const installed = this.sessionsByNodeId.get(registration.nodeId);
    const knownGeneration = Math.max(
      installed && installed !== session ? (installed.connectionGeneration ?? 0) : 0,
      this.latestGenerationByNodeId.get(registration.nodeId) ?? 0,
    );
    if (knownGeneration > registration.connectionGeneration) {
      // Hello results can complete out of order: a later-committed hello already owns the
      // node. No await between this check and the install below.
      this.sessionsBySocket.delete(socket);
      clearTimeout(session.unauthenticatedTimer);
      socket.close(1000, "replaced");
      return;
    }
    this.noteConnectionGeneration(registration.nodeId, registration.connectionGeneration);
    session.nodeId = registration.nodeId;
    session.slug = registration.slug;
    session.connectionGeneration = registration.connectionGeneration;
    session.registered = true;
    session.protocolVersion = message.protocolVersion;
    session.nodeVersion = message.node.version ?? null;
    session.trust = registration.effectiveTrust;
    session.features = message.features;
    session.terminalPublicKey = message.node.terminalPublicKey;
    session.terminalIdentity = message.node.terminalIdentity ?? null;
    session.lastHeartbeatAt = now;
    session.routingEvaluation = createRoutingEvaluationState(
      session.identity.userId,
      registration.nodeId,
    );
    clearTimeout(session.unauthenticatedTimer);
    this.replaceDuplicateSession(session);
    this.notifyTerminalListChanged(session.identity.userId);

    // Targets opened only by this node's disconnect are probed now, not after the cooldown.
    await markTargetsDueAfterNodeReconnect({ nodeId: registration.nodeId, now: new Date() }).catch(
      () => 0,
    );
    this.targetRecovery.wake();
    this.startAffinityObserverMaintenance();

    const ref = this.sessionRef(session);
    if (!ref || !this.isCurrent(session)) return;
    let definitionSync: "expect" | "none" = "none";
    if (session.trust === "full" && this.frameHandlers.definitionSync) {
      try {
        definitionSync = await this.frameHandlers.definitionSync(ref);
      } catch (error) {
        console.error("[relay] definition sync check failed", errorName(error));
      }
      if (!this.isCurrent(session)) return;
    }
    this.sendControl(session, {
      type: "hello.ok",
      id: message.id,
      protocolVersion: message.protocolVersion,
      nodeId: registration.nodeId,
      definitionSync,
    });
    session.helloAcked = true;
    if (registration.trustLowerPending) {
      this.sendControl(session, {
        type: "trust.lower",
        id: `trust-${randomBytes(8).toString("hex")}`,
        requestedAt: (registration.trustLowerRequestedAt ?? now).toISOString(),
      });
    }
    await this.seedCounterEpochs(registration.nodeId, session.identity.userId);
    if (!this.isCurrent(session)) return;
    try {
      await this.frameHandlers.nodeReady?.(ref);
    } catch (error) {
      console.error("[relay] node ready handler failed", errorName(error));
    }
  }

  /** `node.state`: trust or features changed on the node (CLI switch, applied lowering). */
  private async handleNodeState(
    session: SessionState,
    message: NodeFrame<"node.state">,
    now: Date,
  ) {
    const nodeId = session.nodeId;
    if (!nodeId) return;
    let result: { trustLowerPending: boolean } | null = null;
    try {
      result = await writeNodeState({
        nodeId,
        generation: session.connectionGeneration,
        trust: message.trust.value,
        features: message.features,
        now,
      });
    } catch (error) {
      console.error("[relay] node state write failed", errorName(error));
    }
    if (!this.isCurrent(session)) return;
    session.features = message.features;
    const before = session.trust;
    // Fail closed: an unconfirmed lowering (or an unknown stored state) keeps the node Relay.
    session.trust = result && !result.trustLowerPending ? message.trust.value : "relay";
    this.reconcileTrust(session);
    this.notifyTerminalListChanged(session.identity.userId);
    const ref = this.sessionRef(session);
    if (before !== "full" && session.trust === "full" && ref) {
      try {
        await this.frameHandlers.trustRaised?.(ref);
      } catch (error) {
        console.error("[relay] trust raised handler failed", errorName(error));
      }
    }
  }

  /** Ends whatever the node's current trust and features no longer allow. */
  private reconcileTrust(session: SessionState) {
    // Browser shells need Full control; operator terminals only the node's feature.
    if (!this.terminalsAllowed(session)) {
      for (const terminal of [...session.terminalsById.values()])
        if (!terminal.operator) this.closeTerminal(session, terminal, true);
    }
    if (!this.operatorTerminalsAllowed(session)) {
      for (const tracker of [...session.operatorSteps.values()])
        if (!tracker.cancelled) this.cancelOperatorStep(session, tracker, "SYSTEM");
    }
    const roots = session.features?.files.roots ?? null;
    const lost: FileOpLossCause | null =
      session.trust !== "full"
        ? "trust_relay"
        : roots === null || roots.length === 0
          ? "no_roots"
          : null;
    if (lost) {
      for (const op of [...session.filesById.values()]) {
        this.sendControl(session, { type: "file.cancel", opId: op.opId });
        op.markLost(lost);
      }
    }
  }

  private async handleInventoryChunk(
    session: SessionState,
    message: NodeFrame<"runtime.inventory">,
  ) {
    const fail = (snapshotId: string, text: string) => {
      if (session.inventory) clearTimeout(session.inventory.timer);
      session.inventory = null;
      this.sendControl(session, { type: "runtime.inventory.error", snapshotId, message: text });
    };
    let assembly = session.inventory;
    if (message.chunkIndex === 0) {
      if (assembly) clearTimeout(assembly.timer);
      const timer = setTimeout(() => {
        if (session.inventory?.snapshotId === message.snapshotId) {
          fail(message.snapshotId, "The inventory snapshot did not complete in time.");
        }
      }, RUNTIME_INVENTORY_SNAPSHOT_TIMEOUT_MS);
      timer.unref?.();
      assembly = {
        snapshotId: message.snapshotId,
        nextIndex: 0,
        alwaysOn: [],
        instances: [],
        timer,
      };
      session.inventory = assembly;
    }
    if (
      !assembly ||
      assembly.snapshotId !== message.snapshotId ||
      assembly.nextIndex !== message.chunkIndex
    ) {
      fail(message.snapshotId, "Inventory chunks arrived out of order.");
      return;
    }
    if (
      assembly.alwaysOn.length +
        assembly.instances.length +
        message.alwaysOn.length +
        message.instances.length >
      RUNTIME_INVENTORY_SNAPSHOT_MAX_ENTRIES
    ) {
      fail(message.snapshotId, "The inventory snapshot is too large.");
      return;
    }
    assembly.alwaysOn.push(...message.alwaysOn);
    assembly.instances.push(...message.instances);
    assembly.nextIndex += 1;
    if (!message.final) return;
    clearTimeout(assembly.timer);
    session.inventory = null;
    const snapshot: RuntimeInventorySnapshot = {
      snapshotId: assembly.snapshotId,
      alwaysOn: assembly.alwaysOn,
      instances: assembly.instances,
    };
    const ref = this.sessionRef(session);
    if (!ref) return;
    let answer: { ok: true } | { ok: false; message: string } = { ok: true };
    if (this.frameHandlers.runtimeInventory) {
      try {
        answer = await this.frameHandlers.runtimeInventory(ref, snapshot);
      } catch (error) {
        console.error("[relay] inventory handler failed", errorName(error));
        answer = { ok: false, message: "The server could not store the inventory." };
      }
    }
    if (!this.isCurrent(session)) return;
    if (!answer.ok) {
      this.sendControl(session, {
        type: "runtime.inventory.error",
        snapshotId: snapshot.snapshotId,
        message: answer.message,
      });
      return;
    }
    const nodeId = ref.nodeId;
    session.servedHandles = servedHandlesOf(snapshot);
    this.forgetInstancesOfNode(nodeId);
    this.pruneCounterEpochs(nodeId, session.servedHandles);
    for (const key of [...session.runtimeLoad.keys()]) {
      const entry = session.runtimeLoad.get(key);
      if (entry && !session.servedHandles.has(entry.endpointSlug)) session.runtimeLoad.delete(key);
    }
    const sttLink = this.sttLinks.get(session);
    if (sttLink) this.stt.endpointsChanged(sttLink, session.servedHandles);
    this.sendControl(session, { type: "runtime.inventory.ok", snapshotId: snapshot.snapshotId });
    await registerAffinityObservers({
      nodeId,
      handles: [...session.servedHandles],
      connectionGeneration: ref.connectionGeneration,
      managerId: this.affinityObserverManagerId,
    }).catch(() => {});
  }

  handleBinaryFrame(socket: RelaySocket, frame: ArrayBuffer) {
    const session = this.sessionsBySocket.get(socket);
    if (!session?.registered) return;
    try {
      const parsed = parseRelayBinaryFrame(frame);
      if (parsed.metadata.type === "relay.response.body") {
        this.ownedRelayRequest(session, parsed.metadata.requestId)?.onBody(
          parsed.body,
          parsed.metadata,
        );
        return;
      }
      if (parsed.metadata.type === "term.sealed") {
        this.forwardSealedToBrowser(session, parsed.metadata, parsed.body);
        return;
      }
      // file.data: only the session that got the op may answer it; anything else is dropped.
      session.filesById.get(parsed.metadata.opId)?.markData(parsed.body);
    } catch (error) {
      const target = binaryFrameTarget(frame);
      if (target?.type === "term.sealed" && target.terminalId) {
        const terminal = session.terminalsById.get(target.terminalId);
        if (terminal) this.closeTerminal(session, terminal, true);
      } else if (target?.type === "file.data" && target.opId) {
        // A malformed answer fails that op only; the session stays.
        session.filesById.get(target.opId)?.markMalformed();
      }
      console.error("[relay] binary frame rejected", errorName(error));
    }
  }

  async removeSession(socket: RelaySocket, now = new Date()) {
    await this.detachSession(socket, { now, failureClass: "WEBSOCKET_DISCONNECTED" })?.();
  }

  /** Stops background recovery in controlled shutdowns and unit tests. */
  dispose() {
    this.stopAffinityResetRecovery();
    this.targetRecovery.stop();
    for (const session of this.sessionsBySocket.values()) {
      if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
      if (session.inventory) clearTimeout(session.inventory.timer);
      clearTimeout(session.unauthenticatedTimer);
    }
  }

  private stopAffinityResetRecovery() {
    this.affinityResetClosed = true;
    clearInterval(this.affinityResetTimer);
    clearInterval(this.affinityObserverTimer);
    for (const job of this.pendingAffinityResets.values()) job.release();
    this.pendingAffinityResets.clear();
  }

  /**
   * Drops the session from memory right away and returns its database write, if any.
   * Shutdown detaches every socket before it awaits a single write, so a slow database cannot
   * keep later sockets open.
   */
  private detachSession(
    socket: RelaySocket,
    { now, failureClass }: { now: Date; failureClass: "WEBSOCKET_DISCONNECTED" | "STALE_SESSION" },
  ): (() => Promise<void>) | null {
    const session = this.sessionsBySocket.get(socket);
    if (!session) return null;
    this.teardownInteractiveWork(session);
    clearTimeout(session.unauthenticatedTimer);
    if (session.inventory) clearTimeout(session.inventory.timer);
    session.inventory = null;
    if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
    this.sessionsBySocket.delete(socket);
    this.failActiveRequestsForSession(session);
    this.failSttSessions(session);
    const nodeId = session.nodeId;
    if (!nodeId || this.sessionsByNodeId.get(nodeId) !== session) return null;
    this.sessionsByNodeId.delete(nodeId);
    this.notifyTerminalListChanged(session.identity.userId);
    const ref = this.sessionRef(session);
    const connectionGeneration = session.connectionGeneration;
    return async () => {
      await this.writeNodeDisconnected(nodeId, { now, failureClass, connectionGeneration });
      if (ref) {
        try {
          this.frameHandlers.nodeDisconnected?.(ref);
        } catch (error) {
          console.error("[relay] node disconnected handler failed", errorName(error));
        }
      }
    };
  }

  /**
   * Persists that no session serves this node (connection OFFLINE and its targets'
   * circuit), fenced by the generation the detached session was accepted under: a hello that
   * commits after the detach increments it and the write matches nothing.
   */
  private async writeNodeDisconnected(
    nodeId: string,
    {
      now,
      failureClass,
      connectionGeneration,
    }: {
      now: Date;
      failureClass: "WEBSOCKET_DISCONNECTED" | "STALE_SESSION";
      connectionGeneration: number | null;
    },
  ) {
    // Fail closed on anything but a real generation: no unfenced disconnect.
    if (
      connectionGeneration === null ||
      !Number.isInteger(connectionGeneration) ||
      connectionGeneration < 1
    )
      return;
    const applied = await disconnectNodeAtGeneration({
      nodeId,
      generation: connectionGeneration,
      failureClass,
      now,
    });
    if (applied) this.targetRecovery.wake();
  }

  private noteConnectionGeneration(nodeId: string, generation: number) {
    const known = this.latestGenerationByNodeId.get(nodeId) ?? 0;
    if (generation <= known) return;
    // Re-insert so eviction (oldest first) tracks recency.
    this.latestGenerationByNodeId.delete(nodeId);
    this.latestGenerationByNodeId.set(nodeId, generation);
    if (this.latestGenerationByNodeId.size > 4096) {
      const oldest = this.latestGenerationByNodeId.keys().next().value;
      if (oldest !== undefined) this.latestGenerationByNodeId.delete(oldest);
    }
  }

  /**
   * A hello's registration committed (node ONLINE) after its session was detached. Undo it
   * unless another live session owns the node; a live owner accepted under an older
   * generation adopts the newer one so its own later disconnect still matches the row.
   */
  private async settleDetachedRegistration(
    nodeId: string,
    now: Date,
    connectionGeneration: number,
  ) {
    this.noteConnectionGeneration(nodeId, connectionGeneration);
    const owner = this.sessionsByNodeId.get(nodeId);
    if (owner) {
      if ((owner.connectionGeneration ?? 0) < connectionGeneration)
        owner.connectionGeneration = connectionGeneration;
      return;
    }
    await this.writeNodeDisconnected(nodeId, {
      now,
      failureClass: "WEBSOCKET_DISCONNECTED",
      connectionGeneration,
    });
  }

  async checkStaleSessions(now = new Date()) {
    const staleSessions = [...this.sessionsBySocket.values()].filter(
      (session) =>
        session.registered &&
        session.nodeId &&
        now.getTime() - session.lastHeartbeatAt.getTime() > RELAY_STALE_AFTER_MS,
    );
    for (const session of staleSessions) {
      this.teardownInteractiveWork(session);
      session.socket.close(1001, "stale");
      await this.detachSession(session.socket, { now, failureClass: "STALE_SESSION" })?.();
    }
  }

  /**
   * Start of HTTP drain. New relay work is refused. Sockets with no in-flight model request
   * are closed now; a socket that still has one stays up until it finishes or the drain
   * timeout force-closes every connection.
   */
  async closeIdleRelaySessions(now = new Date()) {
    this.beginDrain();
    await this.shutdownRelaySessions(
      [...this.sessionsBySocket.values()].filter(
        (session) => !this.sessionHasActiveRelayWork(session),
      ),
      now,
    );
  }

  /** Refuse new relay and terminal sockets. Synchronous, idempotent and never undone. */
  beginDrain() {
    this.relayDrain = true;
    this.stopAffinityResetRecovery();
    // Live transcription streams cannot be resumed and would hold their node sockets
    // through the whole HTTP drain: they end now (clients reconnect).
    this.stt.closeAll();
  }

  isDraining(): boolean {
    return this.relayDrain;
  }

  /** Shutdown step: cancel interactive work, close remaining node sockets, mark nodes offline. */
  async closeRelaySessions(now = new Date()) {
    this.beginDrain();
    this.stt.closeAll();
    await Promise.allSettled([...this.affinityResetWrites]);
    await this.shutdownRelaySessions([...this.sessionsBySocket.values()], now);
  }

  private async shutdownRelaySessions(sessions: SessionState[], now: Date) {
    // Close every socket first. Only then touch the database.
    let failure: unknown;
    const recordFailure = (error: unknown) => {
      failure = error;
      console.error("[relay] closeRelaySessions failed", errorName(error));
    };
    const writes: Array<() => Promise<void>> = [];
    for (const session of sessions) {
      try {
        const write = this.shutdownRelaySession(session, now);
        if (write) writes.push(write);
      } catch (error) {
        recordFailure(error);
      }
    }
    for (const write of writes) {
      try {
        await write();
      } catch (error) {
        recordFailure(error);
      }
    }
    if (failure) throw failure instanceof Error ? failure : new Error("closeRelaySessions failed");
  }

  private shutdownRelaySession(session: SessionState, now: Date): (() => Promise<void>) | null {
    if (!this.sessionsBySocket.has(session.socket)) return null;
    this.teardownInteractiveWork(session);
    if (session.socket.readyState === WS_READY_STATE_OPEN) {
      session.socket.close(SHUTDOWN_CLOSE_CODE, SHUTDOWN_CLOSE_REASON);
    }
    return this.detachSession(session.socket, { now, failureClass: "WEBSOCKET_DISCONNECTED" });
  }

  private sessionHasActiveRelayWork(session: SessionState): boolean {
    if (session.bodyStreamsByRequest.size > 0) return true;
    const sttLink = this.sttLinks.get(session);
    if (sttLink && this.stt.hasActiveLegs(sttLink)) return true;
    if (!session.nodeId) return false;
    for (const active of this.activeRelayRequests.values()) {
      if (active.nodeId === session.nodeId) return true;
    }
    return false;
  }

  private takeActiveRelayRequest(requestId: string): ActiveRelayRequest | undefined {
    const active = this.activeRelayRequests.get(requestId);
    if (!active) return undefined;
    this.activeRelayRequests.delete(requestId);
    return active;
  }

  private ownedRelayRequest(
    session: SessionState,
    requestId: string,
  ): ActiveRelayRequest | undefined {
    const active = this.activeRelayRequests.get(requestId);
    if (!active || active.nodeId !== session.nodeId) return undefined;
    return active;
  }

  private takeOwnedRelayRequest(
    session: SessionState,
    requestId: string,
  ): ActiveRelayRequest | undefined {
    const active = this.ownedRelayRequest(session, requestId);
    if (!active) return undefined;
    this.activeRelayRequests.delete(requestId);
    return active;
  }

  /** During drain, close a node socket once its last model request has finished. */
  private considerDrainClose(nodeId: string | null | undefined) {
    if (!this.relayDrain || !nodeId) return;
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session || this.sessionHasActiveRelayWork(session)) return;
    void (async () => {
      await this.shutdownRelaySession(session, new Date())?.();
    })().catch((error: unknown) => {
      console.error("[relay] idle session close failed", errorName(error));
    });
  }

  /**
   * Closes every relay socket, registered or not, that authenticated with one of these node
   * credentials. Called after the revocation commits. Websocket auth refuses the revoked
   * secret from then on, and registration re-checks it inside its transaction.
   * Per-process: sockets held by another replica are refused at their next hello.
   */
  async closeSessionsForRevokedCredentials(revoked: { ids: readonly string[] }, now = new Date()) {
    if (revoked.ids.length === 0) return;
    const ids = new Set(revoked.ids);
    await this.closeSessionsMatching((session) => ids.has(session.identity.credentialId), now);
  }

  /** Closes the sockets of deleted (or forgotten) nodes. */
  async closeSessionsForNodes(nodeIds: readonly string[], now = new Date()) {
    if (nodeIds.length === 0) return;
    const ids = new Set(nodeIds);
    await this.closeSessionsMatching((session) => ids.has(session.identity.nodeId), now);
  }

  /**
   * Closes every relay socket, registered or not, whose identity belongs to a user that was
   * just deleted or marked for deletion (matched by `identity.userId`, so a credential minted
   * between any snapshot and the delete is covered too). From the mark on, credential
   * authentication and registration refuse the user (`userCredentialAccessBlocked`).
   */
  async closeSessionsForUser(userId: string, now = new Date()) {
    await this.closeSessionsMatching((session) => session.identity.userId === userId, now);
  }

  private async closeSessionsMatching(matches: (session: SessionState) => boolean, now: Date) {
    const sessions = [...this.sessionsBySocket.values()].filter(matches);
    // Close and detach every matching socket before any database write.
    const writes: Array<() => Promise<void>> = [];
    for (const session of sessions) {
      this.teardownInteractiveWork(session);
      if (session.socket.readyState === WS_READY_STATE_OPEN) {
        try {
          session.socket.send(
            encodeRelayServerControlMessage(
              protocolErrorMessage({ code: "access_denied", message: "access_denied" }),
            ),
          );
        } catch {
          // Closed below either way.
        }
        session.socket.close(1008, "access_denied");
      }
      const write = this.detachSession(session.socket, {
        now,
        failureClass: "WEBSOCKET_DISCONNECTED",
      });
      if (write) writes.push(write);
    }
    for (const write of writes) {
      try {
        await write();
      } catch (error) {
        console.error("[relay] revoked session status write failed", errorName(error));
      }
    }
  }

  /**
   * Seed last-seen `counterEpoch` from durable instance rows so a replica or reboot still
   * resets KV evidence only on a real epoch change.
   */
  private async seedCounterEpochs(nodeId: string, userId: string) {
    try {
      const rows = await prisma.runtimeInstance.findMany({
        where: { userId, ...servedOnNodeWhere(nodeId) },
        select: { handle: true, loadCounterEpoch: true },
      });
      for (const row of rows) {
        if (row.loadCounterEpoch == null) continue;
        const key = `${nodeId}\0${row.handle}`;
        if (!this.kvCounterEpochByInstance.has(key))
          this.kvCounterEpochByInstance.set(key, row.loadCounterEpoch);
      }
    } catch (error) {
      console.error("[relay] seeding load counter epochs failed", errorName(error));
    }
  }

  private startAffinityObserverMaintenance() {
    this.affinityObserverTimer ??= setInterval(() => {
      if (this.affinityResetClosed || this.affinityObserverRunning) return;
      const pendingKeys = () =>
        [...this.pendingAffinityResets.values()].map((job) => `${job.nodeId}\u0001${job.handle}`);
      this.affinityObserverRunning = (async () => {
        try {
          await renewAffinityObservers(
            this.affinityObserverManagerId,
            [...this.sessionsByNodeId.keys()],
            pendingKeys(),
          );
        } catch {
          // Database-clock lease expiry suppresses confidence without stopping inference.
        }
      })().finally(() => {
        this.affinityObserverRunning = undefined;
      });
      const running = this.affinityObserverRunning;
      this.affinityResetWrites.add(running);
      void running.finally(() => this.affinityResetWrites.delete(running));
      if (!this.affinityObserverRecovery) {
        this.affinityObserverRecovery = (async () => {
          await recoverAffinityObservers();
          if (!this.affinityResetClosed)
            await discoverAffinityObservers(
              this.affinityObserverManagerId,
              [...this.sessionsByNodeId.keys()],
              pendingKeys(),
            );
        })()
          .catch(() => {})
          .finally(() => {
            this.affinityObserverRecovery = undefined;
          });
        const recovery = this.affinityObserverRecovery;
        this.affinityResetWrites.add(recovery);
        void recovery.finally(() => this.affinityResetWrites.delete(recovery));
      }
    }, 500);
    this.affinityObserverTimer.unref?.();
  }

  private pruneCounterEpochs(nodeId: string, handles: ReadonlySet<string>) {
    const prefix = `${nodeId}\0`;
    for (const key of this.kvCounterEpochByInstance.keys()) {
      if (key.startsWith(prefix) && !handles.has(key.slice(prefix.length))) {
        this.kvCounterEpochByInstance.delete(key);
        this.kvResetAtByInstance.delete(key);
      }
    }
    this.trimCounterEpochs();
  }

  private trimCounterEpochs() {
    while (this.kvCounterEpochByInstance.size > KV_COUNTER_EPOCH_CACHE_MAX) {
      const first = this.kvCounterEpochByInstance.keys().next().value;
      if (first === undefined) break;
      this.kvCounterEpochByInstance.delete(first);
      this.kvResetAtByInstance.delete(first);
    }
  }

  /**
   * Reset KV-eviction evidence on a `counterEpoch` change or an explicit `prefixCacheReset`.
   * Only positive proof skips work: a cached epoch equal to the frame's. A missing cache entry
   * is resolved against the durable epoch, and repeated explicit resets inside the debounce
   * window are coalesced into one delayed reset rather than dropped.
   */
  private async noteKvEvictionResetSignal(
    session: SessionState,
    load: Pick<RuntimeLoadFrame, "handle" | "prefixCacheReset" | "counterEpoch">,
    now: Date,
  ) {
    const nodeId = session.nodeId;
    if (!nodeId) return;
    const key = `${nodeId}\0${load.handle}`;
    if (this.affinityResetClosed) return;
    const previousEpoch = this.kvCounterEpochByInstance.get(key);
    const epochUnknown = previousEpoch === undefined;
    const epochChanged = !epochUnknown && load.counterEpoch !== previousEpoch;
    const lastResetMs = this.kvResetAtByInstance.get(key);
    const nowMs = now.getTime();
    const resetRequested = epochChanged || load.prefixCacheReset === true;
    const notBefore =
      resetRequested &&
      !epochChanged &&
      lastResetMs !== undefined &&
      Number.isFinite(nowMs) &&
      nowMs - lastResetMs < KV_EVICTION_RESET_DEBOUNCE_MS
        ? lastResetMs + KV_EVICTION_RESET_DEBOUNCE_MS
        : 0;
    if (!resetRequested && !epochUnknown && !this.pendingAffinityResets.has(key)) {
      // Least-recently-used: an instance that keeps reporting stays cached.
      this.kvCounterEpochByInstance.delete(key);
      this.kvCounterEpochByInstance.set(key, load.counterEpoch);
      return;
    }
    try {
      const existing = this.pendingAffinityResets.get(key);
      if (existing) {
        // New reset evidence supersedes an in-flight snapshot: its completion may not clear
        // this newer fence. Frames repeating the job's epoch leave it alone so it can complete.
        const epochMoved = existing.epoch !== load.counterEpoch;
        if (
          load.prefixCacheReset === true ||
          epochMoved ||
          (epochUnknown && !existing.epochUnknown)
        ) {
          existing.epoch = load.counterEpoch;
          existing.reset ||= resetRequested || epochMoved;
          existing.epochUnknown ||= epochUnknown;
          existing.notBefore = Math.min(existing.notBefore, notBefore);
          existing.now = now;
          existing.version++;
        }
      } else {
        this.pendingAffinityResets.set(key, {
          nodeId,
          connectionGeneration: session.connectionGeneration ?? 0,
          handle: load.handle,
          epoch: load.counterEpoch,
          reset: resetRequested,
          epochUnknown,
          notBefore,
          now,
          version: 0,
          release: beginAffinityReset(nodeId, load.handle, session.identity.userId),
        });
      }
    } catch {
      // Only bounded observation-ledger overload relinquishes a connection.
      session.socket.close(1011, "cache_generation_unavailable");
      await this.removeSession(session.socket, now);
      return;
    }
    this.affinityResetTimer ??= setInterval(() => {
      if (this.affinityResetClosed || this.affinityResetRecoveryRunning) return;
      this.affinityResetRecoveryRunning = true;
      void (async () => {
        // At most four due jobs each tick; rotation keeps recovery fair.
        const tickMs = Date.now();
        const due = [...this.pendingAffinityResets.entries()]
          .filter(([, job]) => job.notBefore <= tickMs && !job.running)
          .slice(0, 4);
        for (const [retryKey] of due) {
          if (this.affinityResetClosed) break;
          await this.runAffinityReset(retryKey);
        }
      })().finally(() => {
        this.affinityResetRecoveryRunning = false;
      });
    }, 1000);
    this.affinityResetTimer.unref?.();
    await this.runAffinityReset(key, nowMs);
  }

  /** `nowMs` is the triggering frame's receipt time, or the clock for timer retries. */
  private runAffinityReset(key: string, nowMs = Date.now()): Promise<void> {
    const job = this.pendingAffinityResets.get(key);
    if (!job || this.affinityResetClosed) return Promise.resolve();
    if (job.running) return job.running;
    const { nodeId, connectionGeneration, handle, epoch, epochUnknown, now, version } = job;
    // Move attempts to the tail, keeping a bounded fair recovery worklist.
    this.pendingAffinityResets.delete(key);
    this.pendingAffinityResets.set(key, job);
    // A delayed reset keeps local confidence paused (its ledger entry is held) until it runs.
    if (job.notBefore > nowMs) return Promise.resolve();
    job.running = (async () => {
      try {
        const reset =
          job.reset ||
          (epochUnknown &&
            (await readAffinityCounterEpoch(nodeId, handle).then((durable) =>
              // A node process starts each instance's counters at epoch 0. With nothing stored
              // yet, a later epoch means a reset this server may not have seen.
              durable === null ? epoch > 0 : durable !== epoch,
            )));
        const observations = reset
          ? await observeAffinityReset({
              nodeId,
              handles: [handle],
              connectionGeneration,
              managerId: this.affinityObserverManagerId,
            })
          : [];
        if (reset) await resetKvEvictionForInstance(nodeId, handle, now);
        await persistAffinityCounterEpoch(nodeId, handle, epoch);
        if (this.affinityResetClosed || job.version !== version) return;
        await acknowledgeAffinityObservations(observations);
        if (this.affinityResetClosed || job.version !== version) return;
        this.kvCounterEpochByInstance.set(key, epoch);
        this.trimCounterEpochs();
        if (reset && Number.isFinite(now.getTime()))
          this.kvResetAtByInstance.set(key, now.getTime());
        job.release();
        this.pendingAffinityResets.delete(key);
      } catch {
        // The affected physical capacity remains unknown until durable intent and epoch
        // consumption both commit. Ordinary routing is unaffected.
      } finally {
        job.running = undefined;
      }
    })();
    const running = job.running;
    this.affinityResetWrites.add(running);
    void running.finally(() => this.affinityResetWrites.delete(running));
    return running;
  }

  private forgetInstancesOfNode(nodeId: string) {
    const prefix = `${nodeId}\0`;
    for (const key of [...this.instanceByHandle.keys()]) {
      if (key.startsWith(prefix)) this.instanceByHandle.delete(key);
    }
  }

  /** The instance a `runtime.load` handle names, served by this node for its owner. */
  private async resolveInstance(
    nodeId: string,
    userId: string,
    handle: string,
    nowMs: number,
  ): Promise<ResolvedInstance | null> {
    const key = `${nodeId}\0${handle}`;
    const cached = this.instanceByHandle.get(key);
    if (cached && cached.expiresAtMs > nowMs) return cached.value;
    let value: ResolvedInstance | null = null;
    try {
      const row = await prisma.runtimeInstance.findFirst({
        where: { userId, handle, ...servedOnNodeWhere(nodeId) },
        select: {
          id: true,
          runtimeId: true,
          versionId: true,
          engineSlots: true,
          loadSignals: true,
          Version: { select: { engine: true, kvFullThreshold: true } },
        },
      });
      value = row
        ? {
            instanceId: row.id,
            runtimeId: row.runtimeId,
            versionId: row.versionId,
            engine: {
              engine: row.Version?.engine ?? null,
              kvFullThreshold: row.Version?.kvFullThreshold ?? null,
              engineSlots: row.engineSlots ?? null,
              loadSignals: row.loadSignals ?? [],
            },
          }
        : null;
    } catch (error) {
      console.error("[relay] resolving a load handle failed", errorName(error));
      return null;
    }
    this.instanceByHandle.delete(key);
    this.instanceByHandle.set(key, {
      value,
      expiresAtMs: nowMs + (value ? INSTANCE_CACHE_HIT_TTL_MS : INSTANCE_CACHE_MISS_TTL_MS),
    });
    while (this.instanceByHandle.size > INSTANCE_CACHE_MAX) {
      const first = this.instanceByHandle.keys().next().value;
      if (first === undefined) break;
      this.instanceByHandle.delete(first);
    }
    return value;
  }

  /**
   * `runtime.load`: resolved to its instance (an unknown handle is dropped), then the KV
   * reset signal, the in-memory reading, the minute rollup and a routing evaluation. Frames
   * above the rate limit keep their counter deltas but not their reading.
   */
  private async handleRuntimeLoad(session: SessionState, load: RuntimeLoadFrame, now: Date) {
    const nodeId = session.nodeId;
    if (!nodeId) return;
    const nowMs = now.getTime();
    const instance = await this.resolveInstance(
      nodeId,
      session.identity.userId,
      load.handle,
      nowMs,
    );
    if (!instance || !this.isCurrent(session)) return;
    // Reset evidence is evaluated for every frame before any lossy bookkeeping.
    await this.noteKvEvictionResetSignal(session, load, now);
    const key = `${load.handle}\u0000${load.model ?? ""}`;
    const previous = session.runtimeLoad.get(key);
    const hitsDelta = load.prefixCacheHitsDelta ?? 0;
    const queriesDelta = load.prefixCacheQueriesDelta ?? 0;
    if (previous && nowMs - previous.receivedAtMs < RUNTIME_LOAD_MIN_INTERVAL_MS) {
      previous.prefixCacheHitsTotal = addCapped(previous.prefixCacheHitsTotal ?? 0, hitsDelta);
      previous.prefixCacheQueriesTotal = addCapped(
        previous.prefixCacheQueriesTotal ?? 0,
        queriesDelta,
      );
      return;
    }
    if (!previous && session.runtimeLoad.size >= RUNTIME_LOAD_MAX_KEYS) return;
    // "Sustained" waiting counts consecutive accepted frames; a gap past the staleness window
    // restarts the count (fail open).
    const continuous = previous && nowMs - previous.receivedAtMs <= ENDPOINT_LOAD_STALE_AFTER_MS;
    const waitingStreak =
      load.waiting != null && load.waiting > 0
        ? (continuous ? (previous.waitingStreak ?? 0) : 0) + 1
        : 0;
    session.runtimeLoad.set(key, {
      endpointSlug: load.handle,
      modelSlug: load.model ?? null,
      running: load.running,
      ...(load.waiting !== undefined ? { waiting: load.waiting } : {}),
      ...(load.kvUsage !== undefined ? { kvUsage: load.kvUsage } : {}),
      ...(load.kvOccupancy !== undefined ? { kvOccupancy: load.kvOccupancy } : {}),
      ...(load.slotsBusy !== undefined ? { slotsBusy: load.slotsBusy } : {}),
      ...(load.deferred !== undefined ? { deferred: load.deferred } : {}),
      source: load.source,
      waitingStreak,
      prefixCacheHitsTotal: addCapped(previous?.prefixCacheHitsTotal ?? 0, hitsDelta),
      prefixCacheQueriesTotal: addCapped(previous?.prefixCacheQueriesTotal ?? 0, queriesDelta),
      receivedAt: now,
      receivedAtMs: nowMs,
      instanceId: instance.instanceId,
      counterEpoch: load.counterEpoch,
    });
    observeRuntimeLoadRollup({
      ownerUserId: session.identity.userId,
      instanceId: instance.instanceId,
      runtimeId: instance.runtimeId,
      versionId: instance.versionId,
      nodeId,
      receivedAt: now,
      running: load.running,
      waiting: load.waiting,
      kvUsage: load.kvUsage,
      kvOccupancy: load.kvOccupancy,
      slotsBusy: load.slotsBusy,
      prefixCacheHitsDelta: hitsDelta,
      prefixCacheQueriesDelta: queriesDelta,
      source: load.source,
      // FULL as the live verdict judges this engine (whatever the version's gate).
      full: evaluateEngineLoad(
        historyEngineFacts(instance.engine, load.source),
        {
          running: load.running,
          waiting: load.waiting,
          kvUsage: load.kvUsage,
          slotsBusy: load.slotsBusy,
          deferred: load.deferred,
          source: load.source,
          waitingStreak,
          receivedAt: now,
        },
        now,
      ).full,
    });
    this.scheduleRoutingEvaluation(session);
  }

  /**
   * Telemetry. Frames above the rate limits are dropped, never fatal. The freshest metrics
   * stay in memory; the Node row gets `node.info` and a metrics snapshot at most once a minute.
   */
  private async handleTelemetry(
    session: SessionState,
    message: NodeInfoFrame | NodeMetricsFrame,
    now: Date,
  ) {
    const nodeId = session.nodeId;
    if (!nodeId) return;
    const nowMs = now.getTime();
    if (message.type === "node.info") {
      if (
        session.nodeInfoAcceptedAtMs !== null &&
        nowMs - session.nodeInfoAcceptedAtMs < NODE_INFO_MIN_INTERVAL_MS
      ) {
        return;
      }
      session.nodeInfoAcceptedAtMs = nowMs;
      const { type: _type, ...info } = message;
      await writeNodeTelemetry(nodeId, { nodeInfo: info, nodeInfoAt: now }).catch(
        (error: unknown) =>
          console.error("[relay] storing node telemetry failed", errorName(error)),
      );
      return;
    }
    if (
      session.nodeMetricsAcceptedAtMs !== null &&
      nowMs - session.nodeMetricsAcceptedAtMs < NODE_METRICS_MIN_INTERVAL_MS
    ) {
      return;
    }
    session.nodeMetricsAcceptedAtMs = nowMs;
    const { type: _type, ...frame } = message;
    const {
      ts: _ts,
      custom: _custom,
      metricCommands: _metricCommands,
      abandonedRecovery: _abandonedRecovery,
      ...legacy
    } = frame;
    const sample = parseNodeMetricsSample(legacy);
    session.nodeMetrics = { frame, sample, receivedAt: now };
    const maxOf = (values: Array<number | null | undefined>) =>
      values.reduce<number | null>(
        (max, value) => (value == null ? max : max == null ? value : Math.max(max, value)),
        null,
      );
    observeNodeMetricsRollup({
      ownerUserId: session.identity.userId,
      nodeId,
      receivedAt: now,
      cpuPercent: frame.cpu?.usagePercent,
      memoryAvailableMiB: frame.memory?.availableMiB,
      memoryTotalMiB: frame.memory?.totalMiB,
      gpuTemperatureC: maxOf((frame.gpus ?? []).map((gpu) => gpu.temperatureC)),
      gpuUtilizationPercent: maxOf((frame.gpus ?? []).map((gpu) => gpu.utilizationPercent)),
      acceleratorFreeMiB: (frame.gpus ?? []).reduce<number | null>(
        (sum, gpu) =>
          gpu.vramTotalMiB == null || gpu.vramUsedMiB == null
            ? sum
            : (sum ?? 0) + Math.max(0, gpu.vramTotalMiB - gpu.vramUsedMiB),
        null,
      ),
      custom: frame.custom,
    });
    this.scheduleRoutingEvaluation(session);
    if (
      session.nodeMetricsPersistedAtMs !== null &&
      nowMs - session.nodeMetricsPersistedAtMs < NODE_METRICS_PERSIST_INTERVAL_MS
    ) {
      return;
    }
    session.nodeMetricsPersistedAtMs = nowMs;
    await writeNodeTelemetry(
      nodeId,
      { nodeMetrics: frame, nodeMetricsAt: now },
      // Per node, not per session: a snapshot stored by an earlier session (or another
      // server instance) inside the window keeps this one out.
      {
        OR: [
          { nodeMetricsAt: null },
          { nodeMetricsAt: { lte: new Date(nowMs - NODE_METRICS_PERSIST_INTERVAL_MS) } },
        ],
      },
    ).catch((error: unknown) =>
      console.error("[relay] storing node telemetry failed", errorName(error)),
    );
  }

  private scheduleRoutingEvaluation(session: SessionState) {
    const state = session.routingEvaluation;
    if (!state) return;
    this.routingEvaluator.schedule(state, () => ({
      nodeMetrics:
        session.nodeMetrics?.sample != null
          ? { sample: session.nodeMetrics.sample, receivedAt: session.nodeMetrics.receivedAt }
          : null,
      runtimeLoad: [...session.runtimeLoad.values()],
    }));
  }

  /** A pool's metric routing rules were replaced: clear its stored verdicts. */
  async onPoolRoutingRulesChanged(poolId: string): Promise<void> {
    await this.routingEvaluator.clearPool(poolId);
  }

  /** The freshest node metrics and runtime load per connected node. */
  getLiveNodeTelemetry(nodeIds: readonly string[]): Map<string, LiveNodeTelemetry> {
    const snapshots = new Map<string, LiveNodeTelemetry>();
    for (const nodeId of nodeIds) {
      const session = this.sessionsByNodeId.get(nodeId);
      if (!session?.registered) continue;
      snapshots.set(nodeId, {
        nodeMetrics: session.nodeMetrics?.frame ?? null,
        nodeMetricsReceivedAt: session.nodeMetrics?.receivedAt ?? null,
        runtimeLoad: [...session.runtimeLoad.values()].map(
          ({ receivedAtMs: _receivedAtMs, ...load }) => load,
        ),
      });
    }
    return snapshots;
  }

  /** The node's live session state, or null while it has no registered session. */
  getLiveNodeState(nodeId: string): LiveNodeState | null {
    const session = this.sessionsByNodeId.get(nodeId);
    if (
      !session?.registered ||
      !session.slug ||
      !session.protocolVersion ||
      !session.features ||
      !session.terminalPublicKey
    )
      return null;
    return {
      nodeId,
      userId: session.identity.userId,
      slug: session.slug,
      protocolVersion: session.protocolVersion,
      nodeVersion: session.nodeVersion,
      trust: session.trust,
      features: session.features,
      terminalPublicKey: session.terminalPublicKey,
      terminalIdentity: session.terminalIdentity,
      servedHandles: [...session.servedHandles],
    };
  }

  terminalCounts(userId: string, nodeId: string): { user: number; node: number } {
    let user = 0;
    let node = 0;
    for (const session of this.sessionsByNodeId.values()) {
      for (const terminal of session.terminalsById.values()) {
        // Operator terminals have their own limits (the engine's, per node).
        if (terminal.phase === "pending" || terminal.operator) continue;
        if (terminal.userId === userId) user += 1;
        if (terminal.nodeId === nodeId) node += 1;
      }
    }
    return { user, node };
  }

  hasTerminal(terminalId: string): boolean {
    for (const session of this.sessionsByNodeId.values()) {
      if (session.terminalsById.has(terminalId)) return true;
    }
    return false;
  }

  /**
   * `connId` names the asking browser socket, so each entry can say whether that tab is
   * attached (or waiting) and whether it is the writer.
   */
  listTerminalsForUser(
    userId: string,
    connId?: string,
  ): Array<{
    terminalId: string;
    nodeId: string;
    /** viewerCount > 0 (kept for the browser list). */
    viewerAttached: boolean;
    viewerCount: number;
    attachedHere: boolean;
    writerHere: boolean;
  }> {
    const terminals: ReturnType<RelaySessionManager["listTerminalsForUser"]> = [];
    for (const session of this.sessionsByNodeId.values()) {
      for (const terminal of session.terminalsById.values()) {
        // Operator terminals are reached by step (runtimes.steps.attach), not from this list.
        if (terminal.userId !== userId || terminal.operator) continue;
        const writer = terminal.writerViewerId;
        const writerConn = writer ? terminal.viewers.get(writer)?.connId : undefined;
        terminals.push({
          terminalId: terminal.terminalId,
          nodeId: terminal.nodeId,
          viewerAttached: terminal.viewers.size > 0,
          viewerCount: terminal.viewers.size,
          attachedHere: connId !== undefined && connViewerIds(terminal, connId).length > 0,
          writerHere: connId !== undefined && writerConn === connId,
        });
      }
    }
    return terminals;
  }

  /** Tell the browser hub that this user's terminal list changed. */
  notifyTerminalListChanged(userId: string) {
    terminalBridge?.onTerminalEvent({ type: "list_changed", userId });
  }

  /**
   * Open a terminal on a node that already passed eligibility. `connId` is the opening
   * browser socket; the opener joins the viewer set on term.opened. Returns false without
   * sending when the node cannot accept term.open (offline, Relay only, no terminals).
   */
  startTerminal(input: {
    terminalId: string;
    userId: string;
    nodeId: string;
    cols: number;
    rows: number;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
    connId: string;
    viewerId?: string;
  }): boolean {
    const session = this.sessionsByNodeId.get(input.nodeId);
    if (!session) return false;
    if (!nodeOwnerMatches({ userId: session.identity.userId }, input.userId, "terminal_open"))
      return false;
    if (!this.canStartTerminal(session)) return false;
    if (this.hasTerminal(input.terminalId)) return false;
    const approvalRequired = session.features?.terminals.approvalRequired === true;
    const counts = this.terminalCounts(input.userId, input.nodeId);
    if (!approvalRequired && terminalLimitReached(counts)) return false;
    const now = Date.now();
    const viewerId = input.viewerId ?? mintViewerId();
    const terminal: TerminalRecord = {
      terminalId: input.terminalId,
      userId: input.userId,
      nodeId: input.nodeId,
      cols: input.cols,
      rows: input.rows,
      viewers: new Map(),
      pendingViewers: new Map([[viewerId, { connId: input.connId, requestedAt: now }]]),
      writerViewerId: null,
      phase: approvalRequired ? "pending" : "opening",
      createdAt: now,
      operator: null,
    };
    session.terminalsById.set(terminal.terminalId, terminal);
    this.sendControl(session, {
      type: "term.open",
      terminalId: input.terminalId,
      viewerId,
      cols: input.cols,
      rows: input.rows,
      browserPublicKey: input.browserPublicKey,
      browserNonce: input.browserNonce,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    return true;
  }

  /** Attach a browser socket to a running terminal; each attachment gets a new viewer id. */
  attachTerminal(input: {
    terminalId: string;
    userId: string;
    connId: string;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
  }): { ok: true; viewerId: string } | { ok: false; error: "not_found" | "offline" | "limit" } {
    const located = this.terminalForUser(input.terminalId, input.userId);
    if (!located) return { ok: false, error: "not_found" };
    // An operator terminal is attached only through its step's ticket.
    if (located.terminal.operator) return { ok: false, error: "not_found" };
    if (!this.canStartTerminal(located.session)) return { ok: false, error: "offline" };
    return this.addViewer(located.session, located.terminal, input);
  }

  /**
   * Attach a browser socket to the operator terminal of an interactive step (the ticket from
   * `runtimes.steps.attach` named it). Works on Relay-only nodes: the node only needs its
   * operator-terminal feature.
   */
  attachOperatorTerminal(input: {
    terminalId: string;
    stepId: string;
    userId: string;
    connId: string;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
  }): { ok: true; viewerId: string } | { ok: false; error: "not_found" | "offline" | "limit" } {
    const located = this.terminalForUser(input.terminalId, input.userId);
    if (!located?.terminal.operator || located.terminal.operator.stepId !== input.stepId)
      return { ok: false, error: "not_found" };
    const { session } = located;
    if (
      this.relayDrain ||
      !this.operatorTerminalsAllowed(session) ||
      session.socket.readyState !== WS_READY_STATE_OPEN
    )
      return { ok: false, error: "offline" };
    const tracker = session.operatorSteps.get(input.stepId);
    if (!tracker || tracker.cancelled || tracker.terminalId !== input.terminalId)
      return { ok: false, error: "not_found" };
    return this.addViewer(session, located.terminal, input);
  }

  private addViewer(
    session: SessionState,
    terminal: TerminalRecord,
    input: {
      connId: string;
      browserPublicKey: string;
      browserNonce: string;
      identity?: TerminalHandshakeIdentity;
    },
  ): { ok: true; viewerId: string } | { ok: false; error: "not_found" | "limit" } {
    if (terminal.phase !== "open") return { ok: false, error: "not_found" };
    // A second attach from the same tab replaces that tab's earlier attachment.
    const previous = connViewerIds(terminal, input.connId);
    const occupied = terminal.viewers.size + terminal.pendingViewers.size - previous.length;
    if (occupied >= TERMINAL_VIEWER_LIMIT) return { ok: false, error: "limit" };
    for (const viewerId of previous) this.removeViewer(session, terminal, viewerId);
    const viewerId = mintViewerId(terminal);
    terminal.pendingViewers.set(viewerId, { connId: input.connId, requestedAt: Date.now() });
    this.sendControl(session, {
      type: "term.attach",
      terminalId: terminal.terminalId,
      viewerId,
      browserPublicKey: input.browserPublicKey,
      browserNonce: input.browserNonce,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    return { ok: true, viewerId };
  }

  /** Stop this browser socket's viewing of one terminal; it keeps running for everyone else. */
  detachTerminalViewer(terminalId: string, userId: string, connId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return false;
    const viewerIds = connViewerIds(located.terminal, connId);
    if (viewerIds.length === 0) return false;
    for (const viewerId of viewerIds)
      this.removeViewer(located.session, located.terminal, viewerId);
    return true;
  }

  /** "End session": the owner ends the terminal for everyone. */
  closeTerminalFromBrowser(terminalId: string, userId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    // An operator step is closed by its step (`runtimes.steps.cancel`) or answered in it.
    if (!located || located.terminal.operator) return false;
    this.closeTerminal(located.session, located.terminal, true);
    return true;
  }

  /** The server stamps the viewer id of this socket's pending attachment. */
  forwardTerminalAuth(
    terminalId: string,
    userId: string,
    connId: string,
    signature: string,
  ): "sent" | "not_found" | "offline" {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return "not_found";
    const { session, terminal } = located;
    const viewerId = pendingViewerIdForConn(terminal, connId);
    if (!viewerId) return "not_found";
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return "offline";
    this.sendControl(session, { type: "term.auth", terminalId, viewerId, signature });
    return "sent";
  }

  /** Browser input. Only an attached viewer may send it; the server stamps its viewer id. */
  forwardBrowserSealed(
    terminalId: string,
    userId: string,
    connId: string,
    seq: number,
    body: Uint8Array,
  ): "sent" | "missing" | "dropped" {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return "missing";
    const viewerId = attachedViewerIdForConn(located.terminal, connId);
    if (!viewerId) return "missing";
    const allowed = located.terminal.operator
      ? this.operatorTerminalsAllowed(located.session)
      : this.terminalsAllowed(located.session);
    if (!allowed) return "missing";
    if (located.session.socket.readyState !== WS_READY_STATE_OPEN) return "missing";
    // A slow node must not grow this process without a bound.
    if ((located.session.socket.bufferedAmount ?? 0) > NODE_SEALED_BUFFER_LIMIT) return "dropped";
    const metadata: ServerBinaryMetadata = { type: "term.sealed", terminalId, seq, viewerId };
    located.session.socket.send(encodeRelayBinaryFrame(metadata, body));
    return "sent";
  }

  /**
   * Store a file op and send `file.op` (then `file.body` for a write). False means no frame
   * was sent and the op was not stored: offline, draining, Relay only, no roots, or a session
   * of another owner (an op admitted for one owner never reaches a node another owner runs).
   * The frame is encoded first, so a string the node could not read throws before anything is
   * stored.
   */
  dispatchFileOp(op: TrackedFileOp, frame: ServerFrame<"file.op">, body?: Uint8Array): boolean {
    if (this.relayDrain) return false;
    const session = this.sessionsByNodeId.get(op.nodeId);
    if (!session?.registered || session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    // A path or a file's content goes only to a node of the op's owner (node-owner.ts).
    if (!nodeOwnerMatches({ userId: session.identity.userId }, op.userId, "file_op")) return false;
    const roots = session.features?.files.roots ?? null;
    if (session.trust !== "full" || roots === null || roots.length === 0) return false;
    if (session.filesById.has(op.opId)) return false;
    const control = encodeRelayServerControlMessage(frame);
    const bodyFrame = body
      ? encodeRelayBinaryFrame({ type: "file.body", opId: op.opId }, body)
      : null;
    session.filesById.set(op.opId, op);
    session.socket.send(control);
    if (bodyFrame) session.socket.send(bodyFrame);
    return true;
  }

  /** Ask the node to stop a file op. The op stays until the node answers or its deadline. */
  dispatchFileCancel(nodeId: string, opId: string) {
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session?.filesById.has(opId)) return;
    this.sendControl(session, { type: "file.cancel", opId });
  }

  forgetFileOp(nodeId: string, opId: string) {
    this.sessionsByNodeId.get(nodeId)?.filesById.delete(opId);
  }

  sendRelayRequest({
    nodeId,
    handle,
    requestId,
    family,
    method,
    path,
    headers,
    bodyChunks = [],
    bodySource,
    timeoutMs,
    countFirst = false,
    countCeiling,
  }: {
    nodeId: string;
    handle: string;
    requestId: string;
    family: ServerFrame<"relay.request">["family"];
    method: "GET" | "POST" | "DELETE";
    path: string;
    headers: Headers | Record<string, string>;
    bodyChunks?: Uint8Array[];
    bodySource?: { size: number; open(): AsyncIterable<Uint8Array> };
    timeoutMs: number;
    countFirst?: boolean;
    countCeiling?: number;
  }) {
    if (this.relayDrain) throw new Error("Node session is disconnected.");
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session?.registered) throw new Error("Node session is disconnected.");
    if (session.socket.readyState !== WS_READY_STATE_OPEN) {
      throw new Error("Node session is disconnected.");
    }
    const totalBytes =
      bodySource?.size ?? bodyChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const expectBody = (bodySource?.size ?? 0) > 0 || bodyChunks.length > 0;
    session.socket.send(
      encodeRelayServerControlMessage({
        type: "relay.request",
        requestId,
        family,
        method,
        path,
        headers: sanitizeRelayRequestHeaders(headers),
        timeoutMs,
        handle,
        expectBody,
        // Strict OpenAI-compatible servers refuse a chunked request body (no Content-Length).
        ...(expectBody && totalBytes > 0 ? { bodyBytes: totalBytes } : {}),
        ...(countFirst
          ? { countFirst: true as const, ...(countCeiling != null ? { countCeiling } : {}) }
          : {}),
      }),
    );

    if (!bodySource && bodyChunks.length === 0) return;
    session.bodyStreamsByRequest.set(requestId, {
      chunks: bodySource ? undefined : [...bodyChunks],
      iterator: bodySource?.open()[Symbol.asyncIterator](),
      nextChunkIndex: 0,
      bytesSent: 0,
      totalBytes,
      credits: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
      pumping: false,
    });
    void this.pumpBodyStream(session, requestId);
  }

  /** Every 3.0 node answers `countFirst`. */
  supportsCountContext(nodeId: string): boolean {
    return this.sessionsByNodeId.get(nodeId)?.registered === true;
  }

  private grantBodyCredits(session: SessionState, requestId: string, credits: number) {
    const stream = session.bodyStreamsByRequest.get(requestId);
    if (!stream) return;
    // Clamp the balance to the window: a node spamming acks must not make the server pump
    // the entire buffered body into the socket at once.
    stream.credits = Math.min(stream.credits + credits, RELAY_REQUEST_BODY_WINDOW_CHUNKS);
    void this.pumpBodyStream(session, requestId);
  }

  // Emit request-body chunks while the node has granted credits and the socket can accept
  // them. Each in-flight chunk consumes one credit; the node returns credits via
  // `relay.request.body.ack` as its upstream request consumes them.
  private async pumpBodyStream(session: SessionState, requestId: string) {
    const stream = session.bodyStreamsByRequest.get(requestId);
    if (!stream || stream.pumping) return;
    stream.pumping = true;
    try {
      while (stream.credits > 0 && session.socket.readyState === WS_READY_STATE_OPEN) {
        let chunk = stream.chunks?.shift();
        if (!chunk) {
          const next = await stream.iterator?.next();
          // The request can end, or the session be replaced, while `next()` is pending: never
          // emit the late chunk into the old socket or a new stream reusing the request id.
          if (
            session.bodyStreamsByRequest.get(requestId) !== stream ||
            this.sessionsByNodeId.get(session.nodeId ?? "") !== session
          ) {
            await closeBodyStream(stream);
            return;
          }
          if (!next || next.done) {
            session.bodyStreamsByRequest.delete(requestId);
            await closeBodyStream(stream);
            if (stream.bytesSent !== stream.totalBytes) {
              this.activeRelayRequests.get(requestId)?.onError({
                type: "relay.error",
                requestId,
                failure: "protocol_error",
                message: "Relayed request body ended before its declared size.",
              });
            }
            return;
          }
          chunk = next.value;
        }
        if (chunk.byteLength === 0) continue;
        if (session.bodyStreamsByRequest.get(requestId) !== stream) return;
        if (stream.bytesSent + chunk.byteLength > stream.totalBytes) {
          throw new Error("Relayed request body exceeded its declared size.");
        }
        session.socket.send(
          encodeRelayBinaryFrame(
            {
              type: "relay.request.body",
              requestId,
              chunkId: `${stream.nextChunkIndex}`,
              final: stream.bytesSent + chunk.byteLength === stream.totalBytes,
            },
            chunk,
          ),
        );
        stream.bytesSent += chunk.byteLength;
        this.activeRelayRequests.get(requestId)?.onRequestBodySent?.(chunk.byteLength);
        stream.nextChunkIndex += 1;
        stream.credits -= 1;
      }
    } catch {
      session.bodyStreamsByRequest.delete(requestId);
      await closeBodyStream(stream);
      this.activeRelayRequests.get(requestId)?.onError({
        type: "relay.error",
        requestId,
        failure: "transport",
        message: "Failed to read relayed request body.",
      });
    } finally {
      stream.pumping = false;
    }
  }

  registerRelayResponseHandlers({
    nodeId,
    requestId,
    handlers,
  }: {
    nodeId: string;
    requestId: string;
    handlers: ActiveRelayResponseHandlers;
  }) {
    if (this.activeRelayRequests.has(requestId)) {
      throw new Error("Relay request ID is already active.");
    }
    this.activeRelayRequests.set(requestId, { nodeId, ...handlers });
  }

  completeRelayRequest(requestId: string) {
    const active = this.takeActiveRelayRequest(requestId);
    const nodeIds = new Set<string>();
    if (active) nodeIds.add(active.nodeId);
    for (const session of this.sessionsBySocket.values()) {
      const stream = session.bodyStreamsByRequest.get(requestId);
      if (!stream) continue;
      session.bodyStreamsByRequest.delete(requestId);
      void closeBodyStream(stream);
      if (session.nodeId) nodeIds.add(session.nodeId);
    }
    for (const nodeId of nodeIds) this.considerDrainClose(nodeId);
  }

  cancelRelayRequest({
    nodeId,
    requestId,
    reason,
  }: {
    nodeId: string;
    requestId: string;
    reason: RelayFailure;
  }) {
    this.takeActiveRelayRequest(requestId);
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session) return;
    const stream = session.bodyStreamsByRequest.get(requestId);
    session.bodyStreamsByRequest.delete(requestId);
    void closeBodyStream(stream);
    this.considerDrainClose(nodeId);
    this.sendControl(session, { type: "relay.cancel", requestId, reason });
  }

  /** Nodes with a live, registered session in this process. */
  getOnlineNodeIds(): string[] {
    return [...this.sessionsByNodeId.keys()];
  }

  private replaceDuplicateSession(newSession: SessionState) {
    if (!newSession.nodeId) return;
    const existing = this.sessionsByNodeId.get(newSession.nodeId);
    if (existing && existing !== newSession) {
      // The new session takes over. Tear the old socket down here: once it leaves
      // sessionsBySocket, its close must not mark the node offline. Every viewer attached
      // through the old connection hears its terminal's exit.
      const owners = new Set<string>([newSession.identity.userId]);
      for (const terminal of existing.terminalsById.values()) owners.add(terminal.userId);
      this.teardownInteractiveWork(existing);
      // A replaced session publishes no more verdicts.
      if (existing.routingEvaluation) this.routingEvaluator.cancel(existing.routingEvaluation);
      if (existing.inventory) clearTimeout(existing.inventory.timer);
      existing.inventory = null;
      this.failActiveRequestsForSession(existing);
      this.failSttSessions(existing);
      existing.socket.close(1000, "replaced");
      this.sessionsBySocket.delete(existing.socket);
      clearTimeout(existing.unauthenticatedTimer);
      this.sessionsByNodeId.set(newSession.nodeId, newSession);
      for (const userId of owners) this.notifyTerminalListChanged(userId);
      return;
    }
    this.sessionsByNodeId.set(newSession.nodeId, newSession);
  }

  /** A live speech-to-text session; the caller attaches it to a candidate instance. */
  createSttSession(input: {
    consumer: SttSessionConsumer;
    config?: SttConfig;
    maxSessionMs?: number;
  }): SttCreateResult {
    if (this.relayDrain) return { ok: false, reason: "shutting_down" };
    return this.stt.createSession(input);
  }

  private resolveSttLink(nodeId: string, handle: string) {
    if (this.relayDrain) return { ok: false as const, reason: "draining" as const };
    const session = this.sessionsByNodeId.get(nodeId);
    if (!session?.registered || session.socket.readyState !== WS_READY_STATE_OPEN) {
      return { ok: false as const, reason: "offline" as const };
    }
    if (!session.servedHandles.has(handle)) {
      return { ok: false as const, reason: "endpoint_unavailable" as const };
    }
    return { ok: true as const, link: this.sttLinkFor(session) };
  }

  /** One link per registered node session; a successor session is a new link. */
  private sttLinkFor(session: SessionState): SttRelayLink {
    let link = this.sttLinks.get(session);
    if (link) return link;
    const socket = session.socket;
    link = {
      nodeId: session.nodeId ?? "",
      isOpen: () =>
        socket.readyState === WS_READY_STATE_OPEN && this.sessionsBySocket.get(socket) === session,
      bufferedAmount: () => socket.bufferedAmount ?? 0,
      send: (data) => {
        if (socket.readyState !== WS_READY_STATE_OPEN) {
          throw new Error("Node session is disconnected.");
        }
        socket.send(data);
      },
    };
    this.sttLinks.set(session, link);
    return link;
  }

  /** The node connection is gone or replaced: its live sessions fail. */
  private failSttSessions(session: SessionState) {
    const link = this.sttLinks.get(session);
    if (link) this.stt.linkLost(link);
  }

  private failActiveRequestsForSession(session: SessionState) {
    for (const stream of session.bodyStreamsByRequest.values()) void closeBodyStream(stream);
    session.bodyStreamsByRequest.clear();
    if (!session.nodeId) return;
    for (const [requestId, activeRequest] of this.activeRelayRequests) {
      if (activeRequest.nodeId !== session.nodeId) continue;
      this.activeRelayRequests.delete(requestId);
      activeRequest.onError({
        type: "relay.error",
        requestId,
        failure: "disconnected",
        message: "Node session disconnected.",
      });
    }
  }

  /** Browser shells need Full control (a Relay-only node refuses `term.open`) and terminals. */
  private terminalsAllowed(session: SessionState): boolean {
    return (
      session.registered &&
      session.trust === "full" &&
      session.features?.terminals.supported === true &&
      session.terminalPublicKey !== null
    );
  }

  private canStartTerminal(session: SessionState): boolean {
    return (
      !this.relayDrain &&
      this.terminalsAllowed(session) &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private sendControl(session: SessionState, message: ServerToNodeControlFrame) {
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return;
    try {
      session.socket.send(encodeRelayServerControlMessage(message));
    } catch (error) {
      console.error("[relay] control frame not sent", message.type, errorName(error));
    }
  }

  private teardownInteractiveWork(session: SessionState) {
    this.closeAllTerminals(session, true);
    for (const op of [...session.filesById.values()]) {
      this.sendControl(session, { type: "file.cancel", opId: op.opId });
      op.markLost("node_offline");
    }
  }

  private closeAllTerminals(session: SessionState, signalNode: boolean) {
    for (const terminal of [...session.terminalsById.values()]) {
      this.closeTerminal(session, terminal, signalNode);
    }
  }

  /** Forget a terminal, tell its viewers it exited, and optionally tell the node to close it. */
  private closeTerminal(session: SessionState, terminal: TerminalRecord, signalNode: boolean) {
    session.terminalsById.delete(terminal.terminalId);
    if (signalNode)
      this.sendControl(session, { type: "term.close", terminalId: terminal.terminalId });
    terminalBridge?.onTerminalEvent({
      type: "exit",
      terminalId: terminal.terminalId,
      connIds: terminalConnIds(terminal),
    });
  }

  /** Drop one attachment (attached or pending) and tell the node; the rest hear the count. */
  private removeViewer(session: SessionState, terminal: TerminalRecord, viewerId: string): boolean {
    const wasViewer = terminal.viewers.delete(viewerId);
    const wasPending = terminal.pendingViewers.delete(viewerId);
    if (!wasViewer && !wasPending) return false;
    const writerLeft = terminal.writerViewerId === viewerId;
    if (writerLeft) terminal.writerViewerId = null;
    this.sendControl(session, { type: "term.detach", terminalId: terminal.terminalId, viewerId });
    if (wasViewer || writerLeft) this.emitViewers(terminal);
    return true;
  }

  /** Tell every attached viewer the count and who is typing. */
  private emitViewers(terminal: TerminalRecord) {
    if (terminal.viewers.size === 0) return;
    const writer = terminal.writerViewerId;
    terminalBridge?.onTerminalEvent({
      type: "viewers",
      terminalId: terminal.terminalId,
      count: terminal.viewers.size,
      recipients: [...terminal.viewers].map(([viewerId, viewer]) => ({
        connId: viewer.connId,
        writer: writer === null ? "none" : writer === viewerId ? "you" : "other",
      })),
    });
  }

  /**
   * Drop approval handshakes that never spawned, and attachments the node never answered.
   * Pending terminals do not count toward the terminal cap.
   */
  sweepExpiredPendingTerminals(now = Date.now()) {
    for (const session of this.sessionsByNodeId.values()) {
      for (const terminal of [...session.terminalsById.values()]) {
        if (terminal.phase === "pending") {
          if (now - terminal.createdAt < TERMINAL_PENDING_TTL_MS) continue;
          session.terminalsById.delete(terminal.terminalId);
          // The node may have spawned the shell just before the deadline; a close for a
          // terminal it never opened is a no-op there.
          this.sendControl(session, { type: "term.close", terminalId: terminal.terminalId });
          for (const connId of terminalConnIds(terminal)) {
            terminalBridge?.onTerminalEvent({
              type: "rejected",
              terminalId: terminal.terminalId,
              connId,
              reason: "expired",
            });
          }
          continue;
        }
        if (terminal.phase !== "open") continue;
        for (const [viewerId, pending] of [...terminal.pendingViewers]) {
          if (now - pending.requestedAt < TERMINAL_PENDING_TTL_MS) continue;
          this.removeViewer(session, terminal, viewerId);
          terminalBridge?.onTerminalEvent({
            type: "rejected",
            terminalId: terminal.terminalId,
            connId: pending.connId,
            reason: "expired",
          });
        }
      }
    }
  }

  /** Clear every attachment this browser socket held, including terminals still opening. */
  releaseBrowserViewer(userId: string, connId: string) {
    for (const session of this.sessionsByNodeId.values()) {
      for (const terminal of [...session.terminalsById.values()]) {
        if (terminal.userId !== userId) continue;
        for (const viewerId of connViewerIds(terminal, connId)) {
          this.removeViewer(session, terminal, viewerId);
        }
      }
    }
  }

  private terminalForUser(
    terminalId: string,
    userId: string,
  ): { session: SessionState; terminal: TerminalRecord } | null {
    for (const session of this.sessionsByNodeId.values()) {
      const terminal = session.terminalsById.get(terminalId);
      if (!terminal) continue;
      if (terminal.userId !== userId) return null;
      // The node holding the terminal is its owner's too (defence in depth).
      if (!nodeOwnerMatches({ userId: session.identity.userId }, userId, "terminal_attach"))
        return null;
      return { session, terminal };
    }
    return null;
  }

  /**
   * Node output: a frame names one viewer (unicast) or an output-key epoch (broadcast to
   * every attached viewer). Frames for an unknown viewer, or with neither, are dropped.
   */
  private forwardSealedToBrowser(
    session: SessionState,
    metadata: TerminalSealedMetadata,
    body: Uint8Array,
  ) {
    const terminal = session.terminalsById.get(metadata.terminalId);
    if (!terminal) return;
    const base = {
      type: "sealed" as const,
      terminalId: terminal.terminalId,
      seq: metadata.seq,
      body,
    };
    if (metadata.viewerId !== undefined) {
      const viewer = terminal.viewers.get(metadata.viewerId);
      if (!viewer) return;
      terminalBridge?.onTerminalEvent({ ...base, connIds: [viewer.connId] });
      return;
    }
    if (metadata.epoch === undefined) return;
    const connIds = [...terminal.viewers.values()].map((viewer) => viewer.connId);
    if (connIds.length === 0) return;
    terminalBridge?.onTerminalEvent({ ...base, connIds, epoch: metadata.epoch });
  }

  private handleTerminalControl(
    session: SessionState,
    message: NodeFrame<
      | "term.pending"
      | "term.opened"
      | "term.attached"
      | "term.rejected"
      | "term.writer"
      | "term.input_dropped"
      | "term.exit"
    >,
  ) {
    const terminal = session.terminalsById.get(message.terminalId);
    if (!terminal) {
      // A late open/attach/pending for a terminal we no longer track would leave a shell with
      // no server-side owner. A close for an unknown terminal is a no-op on the node.
      if (
        message.type === "term.opened" ||
        message.type === "term.attached" ||
        message.type === "term.pending"
      ) {
        this.sendControl(session, { type: "term.close", terminalId: message.terminalId });
      }
      return;
    }
    if (message.type === "term.input_dropped") {
      const viewer = message.viewerId ? terminal.viewers.get(message.viewerId) : undefined;
      if (!viewer) return;
      terminalBridge?.onTerminalEvent({
        type: "input_dropped",
        terminalId: terminal.terminalId,
        connId: viewer.connId,
      });
      return;
    }
    if (message.type === "term.exit") {
      session.terminalsById.delete(terminal.terminalId);
      terminalBridge?.onTerminalEvent({
        type: "exit",
        terminalId: terminal.terminalId,
        connIds: terminalConnIds(terminal),
        ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
        ...(message.signal !== undefined ? { signal: message.signal } : {}),
      });
      return;
    }
    if (message.type === "term.writer") {
      const writer = message.viewerId ?? null;
      if (writer !== null && !terminal.viewers.has(writer)) return;
      if (terminal.writerViewerId === writer) return;
      terminal.writerViewerId = writer;
      this.emitViewers(terminal);
      return;
    }
    const viewerId = message.viewerId;
    if (viewerId === undefined) {
      console.error("[relay] terminal frame without a viewer id");
      return;
    }
    if (message.type === "term.pending") {
      const nodePublicKey = session.terminalPublicKey;
      const pending = terminal.pendingViewers.get(viewerId);
      if (!nodePublicKey || !pending) return;
      terminalBridge?.onTerminalEvent({
        type: "pending",
        terminalId: terminal.terminalId,
        connId: pending.connId,
        viewerId,
        cliPublicKey: nodePublicKey,
        cliNonce: message.cliNonce,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
    // The node opens an operator terminal for its job, never for a browser `term.open`.
    if (terminal.operator && message.type === "term.opened") return;
    if (message.type === "term.opened" || message.type === "term.attached") {
      if (message.type === "term.opened") {
        if (terminal.phase === "open") return;
        terminal.phase = "open";
        if (this.terminalOverLimit(terminal)) {
          this.closeTerminal(session, terminal, true);
          return;
        }
      } else if (terminal.phase !== "open") {
        return;
      }
      const nodePublicKey = session.terminalPublicKey;
      if (!nodePublicKey) {
        this.closeTerminal(session, terminal, true);
        return;
      }
      const pending = terminal.pendingViewers.get(viewerId);
      // The tab may have left while the node was spawning or approving.
      if (!pending) return;
      terminal.pendingViewers.delete(viewerId);
      terminal.viewers.set(viewerId, { connId: pending.connId, attachedAt: Date.now() });
      // The opener is the first writer. The node confirms with term.writer.
      if (message.type === "term.opened" && terminal.writerViewerId === null) {
        terminal.writerViewerId = viewerId;
      }
      terminalBridge?.onTerminalEvent({
        type: message.type === "term.opened" ? "opened" : "attached",
        terminalId: terminal.terminalId,
        connId: pending.connId,
        viewerId,
        cliPublicKey: nodePublicKey,
        cliNonce: message.cliNonce,
      });
      this.emitViewers(terminal);
      return;
    }
    // term.rejected
    const target = terminal.pendingViewers.get(viewerId) ?? terminal.viewers.get(viewerId);
    const wasViewer = terminal.viewers.delete(viewerId);
    terminal.pendingViewers.delete(viewerId);
    if (terminal.writerViewerId === viewerId) terminal.writerViewerId = null;
    if (terminal.phase !== "open" && !terminal.operator) {
      // The open itself was refused: nothing spawned.
      session.terminalsById.delete(terminal.terminalId);
    } else if (wasViewer) {
      this.emitViewers(terminal);
    }
    if (!target) return;
    terminalBridge?.onTerminalEvent({
      type: "rejected",
      terminalId: terminal.terminalId,
      connId: target.connId,
      reason: message.reason,
      ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
    });
  }

  private terminalOverLimit(terminal: TerminalRecord): boolean {
    const counts = this.terminalCounts(terminal.userId, terminal.nodeId);
    const limits = terminalLimits();
    return counts.user > limits.user || counts.node > limits.node;
  }

  /**
   * A term.* / file.* / stt.* / telemetry / context.count frame that fails schema validation
   * ends only what it names (or is dropped). Other malformed frames return false so the
   * socket takes the protocol-error path. Nothing of the frame is logged but its type.
   */
  private isolateMalformedInteractiveFrame(session: SessionState, frame: string): boolean {
    if (!session.registered) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") return false;
    if (type.startsWith("term.")) {
      const terminalId = typeof record.terminalId === "string" ? record.terminalId : null;
      const terminal = terminalId ? session.terminalsById.get(terminalId) : undefined;
      if (terminal) this.closeTerminal(session, terminal, true);
      console.error("[relay] malformed terminal frame");
      return true;
    }
    if (type.startsWith("file.")) {
      const opId = typeof record.opId === "string" ? record.opId : null;
      const tracked = opId ? session.filesById.get(opId) : undefined;
      if (tracked) {
        this.sendControl(session, { type: "file.cancel", opId: tracked.opId });
        tracked.markMalformed();
      }
      console.error("[relay] malformed file frame");
      return true;
    }
    if (type.startsWith("stt.")) {
      const sttLink = this.sttLinks.get(session);
      if (sttLink && typeof record.sessionId === "string") {
        this.stt.malformed(sttLink, record.sessionId);
      }
      const nowMs = Date.now();
      if (
        session.malformedSttLoggedAtMs === null ||
        nowMs - session.malformedSttLoggedAtMs >= MALFORMED_TELEMETRY_LOG_INTERVAL_MS
      ) {
        session.malformedSttLoggedAtMs = nowMs;
        console.error("[relay] malformed speech-to-text frame dropped");
      }
      return true;
    }
    if (TELEMETRY_FRAME_TYPES.has(type)) {
      const nowMs = Date.now();
      if (
        session.malformedTelemetryLoggedAtMs === null ||
        nowMs - session.malformedTelemetryLoggedAtMs >= MALFORMED_TELEMETRY_LOG_INTERVAL_MS
      ) {
        session.malformedTelemetryLoggedAtMs = nowMs;
        console.error("[relay] malformed telemetry frame dropped", type);
      }
      return true;
    }
    if (type === "context.count.result" || type === "context.count.error") {
      const requestId = typeof record.requestId === "string" ? record.requestId : null;
      if (!requestId) return false;
      const relay = this.ownedRelayRequest(session, requestId);
      if (!relay) return false;
      relay.onCountError?.({
        type: "context.count.error",
        requestId,
        failure: "protocol_error",
        message: "Malformed context.count frame.",
      });
      console.error("[relay] malformed context.count frame");
      return true;
    }
    return false;
  }

  private async probeTarget(target: RecoveryTarget): Promise<boolean | "superseded"> {
    const start = this.relayAttemptStarter;
    // The probe is only evidence about the connection it was dispatched on: a replaced or
    // lost session's failure belongs to the old connection, not the target.
    const dispatchedOn = this.sessionsByNodeId.get(target.nodeId);
    if (!dispatchedOn || !start) return "superseded";
    const superseded = () => this.sessionsByNodeId.get(target.nodeId) !== dispatchedOn;
    const request = recoveryProbe(target);
    const attempt = start({
      manager: this,
      nodeId: target.nodeId,
      handle: target.handle,
      family: request.family,
      method: "POST",
      path: request.path,
      headers: new Headers(request.headers),
      body: request.body,
      timeoutMs: TARGET_RECOVERY_PROBE_TIMEOUT_MS,
    });
    try {
      const started = await attempt.started;
      // Drain the bounded probe reply so the relay completes normally.
      await started.body.pipeTo(new WritableStream<Uint8Array>({ write() {} }));
      const terminal = await attempt.terminal;
      if (superseded()) return "superseded";
      return started.status >= 200 && started.status < 300 && terminal.ok;
    } catch {
      return superseded() ? "superseded" : false;
    }
  }
}

export const relaySessionManager = new RelaySessionManager();
