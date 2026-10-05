import { randomBytes, randomUUID } from "node:crypto";
import type {
  LiveCliFeatureSnapshot,
  LiveEndpointLoad,
  LiveNodeTelemetrySnapshot,
} from "@ws-model-proxy/api/context";
import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import {
  type FileOpClass,
  fileGrantStageRefusal,
  fileLiveStageRefusal,
} from "@ws-model-proxy/api/lib/cli-file-access";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  lowestMcpCommandMode,
  type McpCommandModeName,
  mcpCommandModeFromDb,
  mcpCommandModeToDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import {
  ENDPOINT_LOAD_STALE_AFTER_MS,
  parseStoredRemoteMetricSources,
} from "@ws-model-proxy/api/lib/metric-routing";
import { suggestedConnectionSurface } from "@ws-model-proxy/api/lib/model-connection-type";
import {
  disconnectCliDeviceAtGeneration,
  markPoolMembersDueAfterCliReconnect,
  type PoolMemberFailureClass,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { parseStoredRemoteEngineAdapters } from "@ws-model-proxy/api/lib/remote-engine-adapters";
import type { SupervisedCommandStatus } from "@ws-model-proxy/api/lib/supervised-command-types";
import {
  type DeploymentInstancesFrame,
  type DeploymentJob,
  type DeploymentJobResult,
  type DeploymentObservedInstance,
  deploymentJobNeedsOperator,
  deploymentOperatorResultStatus,
  deploymentOperatorSupported,
} from "@ws-model-proxy/config/deployment-protocol";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  type DeploymentOperatorAction,
  type DeploymentOperatorOutcome,
  isDeploymentOperatorAction,
  recordDeploymentOperatorEvent,
} from "../deployments/operator-audit.js";
import type { DeploymentLiveSocket, DeploymentSocket } from "../deployments/reconciler.js";
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
import { resetKvEvictionForEndpoint } from "../model-api/kv-eviction-feedback.js";
import { startRelayAttempt } from "../model-api/relay-executor.js";
import { EngineLoadHistoryStore } from "./engine-load-history.js";
import { observeEngineLoadRollup } from "./engine-load-rollup.js";
import {
  type FileOp,
  type FileOpFrame,
  type FileRejectDetail,
  type FileRejectReason,
  type FileResultFrame,
  type FileSpawnSpec,
  isMutatingFileOp,
  type SupervisedFileResult,
  supervisedFileRejectReasonSchema,
} from "./file-protocol.js";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import { relayHelloOrigin, verifyHelloIdentitySignature } from "./hello-identity.js";
import {
  createRoutingEvaluationState,
  MetricRoutingEvaluator,
  type RoutingEvaluationState,
} from "./metric-routing-evaluator.js";
import { observeNodeMetricsRollup } from "./node-metrics-rollup.js";
import {
  listDueOwnedPoolMemberRecoveries,
  type OwnedRecoveryMember,
  POOL_MEMBER_RECOVERY_PROBE_TIMEOUT_MS,
  PoolMemberRecoveryScheduler,
} from "./pool-member-recovery.js";
import {
  type CliTerminalIdentity,
  describeRelayControlParseError,
  type EndpointLoadMessage,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  helloNeedsUpgrade,
  type NodeInfoMessage,
  type NodeMetricsMessage,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  protocolErrorMessage,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_SERVER_UPGRADE_REQUIRED_MESSAGE,
  RELAY_STALE_AFTER_MS,
  RELAY_UNREGISTERED_STALE_AFTER_MS,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
  type RelayBinaryFrameMetadata,
  type RelayClientControlMessage,
  type RelayFailure,
  type RelayProtocolErrorCode,
  type RelayProtocolVersion,
  type RelayResponseBodyMetadata,
  type RelayServerControlMessage,
  type RemoteEngineAdapter,
  type RemoteMetricSource,
  refusedRelayProtocolReason,
  rejectedHelloFacts,
  remoteEngineAdaptersSchema,
  remoteMetricSourcesSchema,
  type TerminalHandshakeIdentity,
  type TerminalSealedMetadata,
} from "./protocol.js";
import {
  persistRelayRegistration,
  RelayRegistrationError,
  type ReportedRelayFeatures,
} from "./registration.js";
import type { SttConfig } from "./stt-protocol.js";
import {
  type SttClientMessage,
  type SttCreateResult,
  SttRelayHub,
  type SttRelayLink,
  type SttSessionConsumer,
} from "./stt-relay.js";

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

// Per-request outbound request-body stream. The server holds the remaining
// body chunks and only emits them while the CLI has granted credits, so a slow
// upstream on one request pauses that request's body flow (its credits stop
// returning) without blocking sibling requests on the same socket.
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
    // The request is already terminal; cleanup is best-effort here. The body
    // source remains responsible for disposing its backing resource.
  }
}

export type CliReportedFeatures = {
  deployments?: boolean;
  /** Interactive deployment commands; see `deploymentOperatorSupported`. */
  deploymentOperator?: boolean;
  humanTerminal: boolean;
  /** The CLI's own MCP command mode (its config), from hello. */
  mcpCommandMode: McpCommandModeName;
  terminalApproval: boolean;
  terminalSupported: boolean;
  /** 2.8: the CLI's read-only file grant. */
  mcpFileRead: boolean;
  /** 2.8: the CLI has `fileRoots` configured. */
  fileRootsConfigured: boolean;
  fileOps: boolean;
  /** 2.8: `wsmp config set-file-tools-as-root on`. */
  allowFileToolsAsRoot: boolean;
};

export type TrackedCliCommand = {
  commandId: string;
  cliDeviceId: string;
  status: "running" | "exited" | "cancelled" | "rejected";
  markCancelled(): void;
  markStarted(): void;
  markRejected(reason: string): void;
  markDone(result: { exitCode?: number; signal?: string; timedOut: boolean }): void;
  appendOutput(stream: "stdout" | "stderr", body: Uint8Array): void;
};

/** Why an in-flight file op ended without an answer from the CLI. */
export type FileOpLossCause = "offline" | "grant_disabled" | "feature_disabled" | "supervised_only";

/** A file op the relay session routes CLI answers to (see `cli-file-ops.ts`). */
export type TrackedFileOp = {
  opId: string;
  cliDeviceId: string;
  op: FileOp;
  markResult(frame: FileResultFrame): void;
  markData(body: Uint8Array): void;
  markRejected(reason: FileRejectReason, detail?: FileRejectDetail): void;
  /** The CLI sent a `file.*` frame for this op that failed the strict schema. */
  markMalformed(): void;
  markLost(cause: FileOpLossCause): void;
};

/** What the terminal socket lists for an agent-requested (supervised) terminal. */
export type SupervisedTerminalListing = {
  commandId: string;
  status: SupervisedCommandStatus;
  requester: string;
  reason: string | null;
  command: string;
  cwd: string | null;
  shareOutput: boolean;
  createdAt: string;
  /** Deadline of the current wait (confirm or review); null otherwise. */
  expiresAt: string | null;
  exitCode: number | null;
  signal: string | null;
};

/** Why a supervised terminal went away, as seen by its command record. */
export type SupervisedTerminalGoneCause =
  /** The CLI reported `term.exit`. */
  | "exit"
  /** The owner ended it from the browser (`close`: End session / Decline). */
  | "user"
  /** A malformed frame closed it, or the server ended it after settling the record. */
  | "closed"
  /** The relay session went away (disconnect, replacement, shutdown, revocation). */
  | "disconnected"
  /** The device policy no longer allows supervised commands. */
  | "policy";

/**
 * A supervised command as the session manager sees it. The record itself
 * (status, output, timers) lives in `cli-commands.ts`; these hooks are how
 * relay frames reach it. Every hook ignores calls that do not fit the
 * record's current status.
 */
export type TrackedSupervisedCommand = {
  kind?: "command" | "file";
  fileOp?: FileSpawnSpec["op"];
  commandId: string;
  terminalId: string;
  cliDeviceId: string;
  userId: string;
  listing(): SupervisedTerminalListing;
  onSpawned(): void;
  onRejected(reason: string): void;
  onAccepted(): void;
  onDeclined(): void;
  onDone(result: {
    exitCode?: number;
    signal?: string;
    review: boolean;
    outputBytes?: number;
    fileResult?: SupervisedFileResult;
    fileError?: { code: import("./file-protocol.js").FileErrorCode };
  }): void;
  onOutput(part: "head" | "tail", body: Uint8Array): void;
  onTerminalGone(cause: SupervisedTerminalGoneCause): void;
  /**
   * The CLI's report on a terminal the server already ended: `accepted`
   * (the command had started) or `settled` (its terminal is gone for good).
   */
  onLateReport(report: "accepted" | "settled"): void;
  /**
   * The owner declined from the browser. Never ends a command that started:
   * `requested` when the request still waited for Enter and the CLI was
   * asked to decline it (the CLI decides; an Enter it took first wins),
   * `started` when the Enter already won, `unavailable` when the CLI could
   * not be asked, `ended` when the request is over.
   */
  requestDecline(): "requested" | "started" | "unavailable" | "ended";
};

/** One browser tab's attachment to a terminal. `connId` is the browser socket. */
type TerminalViewer = { connId: string; attachedAt: number };
type TerminalPendingViewer = { connId: string; requestedAt: number };

export type TerminalRecord = {
  terminalId: string;
  userId: string;
  cliDeviceId: string;
  cols: number;
  rows: number;
  /**
   * True when the CLI negotiated 2.5: viewer ids go on the wire and output is
   * broadcast to every viewer. False keeps the 2.4 single-viewer model, where
   * `viewers` and `pendingViewers` each hold at most one entry.
   */
  multiViewer: boolean;
  /** Attached viewers by server-minted viewer id. */
  viewers: Map<string, TerminalViewer>;
  /**
   * Viewers waiting for the CLI (approval, or term.opened / term.attached).
   * In 2.4 this is the replacement viewer; the current viewer stays until the CLI accepts.
   */
  pendingViewers: Map<string, TerminalPendingViewer>;
  /** 2.5 only. Reported by the CLI with term.writer. */
  writerViewerId: string | null;
  phase: "pending" | "opening" | "open";
  createdAt: number;
  /**
   * `agent`: a supervised terminal the CLI spawned for an MCP request. It
   * has its own slot limits, is gated by the MCP command mode (not the human
   * terminal grant), and starts with no viewers.
   * `deployment`: the operator terminal of an interactive deployment step
   * Registered when the job is sent, open once the CLI reports
   * `awaiting_operator` for it; gated by the node's deployment operator
   * capability (not the human grant or the MCP mode); never idle-closed and
   * never counted against the human terminal limits.
   */
  origin: TerminalOrigin;
  /** Set iff `origin` is `agent`. */
  supervised: TrackedSupervisedCommand | null;
  /** Set iff `origin` is `deployment`. */
  deployment?: DeploymentTerminalInfo;
  /**
   * Agent terminals: browser sockets that sent Decline. They hear whether an
   * Enter beat it (`decline` event, once, on the waiting -> running step) and
   * the terminal's exit, even when they do not view the terminal. Kept until
   * the terminal ends (the set goes with it) or the socket closes (its entry
   * is removed); bounded by the owner's sockets.
   */
  decliners?: Set<string>;
};

export type TerminalOrigin = "user" | "agent" | "deployment";

/** What the terminal list shows for a deployment operator terminal (no command text). */
export type DeploymentTerminalInfo = {
  stepId: string;
  instanceId: string;
  rank: number;
  action: DeploymentOperatorAction;
  /** `awaiting`: the confirm screen waits for Enter; `running`: the command runs. */
  state: "awaiting" | "running";
};

/**
 * One interactive step the session sent with an operator terminal, by step id,
 * from the send until its final result, `operator_closed`, a replacement, a
 * server cancel, or the session's end. It outlives the `TerminalRecord`: the
 * CLI reports `term.exit` before the worker's final result.
 */
type OperatorStepTracker = {
  stepId: string;
  instanceId: string;
  rank: number;
  action: DeploymentOperatorAction;
  intentHash: string;
  ownerEpoch: string;
  terminalId: string;
  userId: string;
  cliDeviceId: string;
  /** `spawning` until the first `awaiting_operator`. */
  phase: "spawning" | "awaiting" | "running";
  /** An Enter started the command at least once in this terminal. */
  attempted: boolean;
  /** The server closed the terminal (`cancelled` is recorded); only routing remains. */
  cancelled: boolean;
};

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
      /** A supervised terminal: its command's status once the terminal ended. */
      supervisedStatus?: SupervisedTerminalListing["status"];
    }
  /** 2.4 only: another tab took the terminal. */
  | { type: "detached"; terminalId: string; connId: string }
  | { type: "input_dropped"; terminalId: string; connId: string }
  | {
      type: "viewers";
      terminalId: string;
      count: number;
      recipients: Array<{ connId: string; writer: TerminalWriterLabel }>;
    }
  /** A Decline these sockets sent lost to an Enter: the command started. */
  | { type: "decline"; terminalId: string; connIds: string[]; outcome: "started" }
  | {
      type: "sealed";
      terminalId: string;
      connIds: string[];
      seq: number;
      /** Set on 2.5 broadcast frames. */
      epoch?: number;
      body: Uint8Array;
    }
  /** This user's terminal list changed without a browser asking (supervised requests). */
  | { type: "list_changed"; userId: string };

type TerminalBridge = {
  onTerminalEvent(event: TerminalLifecycleEvent): void;
};

let terminalBridge: TerminalBridge | null = null;

export function registerTerminalBridge(bridge: TerminalBridge) {
  terminalBridge = bridge;
}

export const TERMINAL_USER_LIMIT = 4;
/**
 * Interactive steps one session may track at once. The reconciler opens at
 * most a few operator terminals per node (design §4: 4); the CLI caps 8.
 */
export const OPERATOR_STEPS_PER_SESSION = 16;
export const TERMINAL_CLI_LIMIT = 2;
/** 2.5: attached viewers plus pending approvals per terminal. */
export const TERMINAL_VIEWER_LIMIT = 8;
const CLI_SEALED_BUFFER_LIMIT = 1024 * 1024;
const TERMINAL_PENDING_TTL_MS = 2 * 60 * 1000;
/** Ended supervised terminals whose CLI `term.exit` is still awaited, per session. */
const ENDING_SUPERVISED_MAX = 16;
const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;
/** `node.info` is once per connection; a repeat inside this window is dropped. */
export const NODE_INFO_MIN_INTERVAL_MS = 60_000;
/**
 * `node.metrics` frames closer together than this are dropped. The CLI keeps
 * them at least 5 s apart; the margin absorbs network jitter.
 */
export const NODE_METRICS_MIN_INTERVAL_MS = 4_000;
/**
 * The CliDevice snapshot of the latest metrics is written at most this often
 * per device, across sessions and server instances (the write is conditional
 * on the stored `nodeMetricsAt`), so reconnecting cannot reset the budget.
 */
export const NODE_METRICS_PERSIST_INTERVAL_MS = 60_000;
/** A dropped malformed telemetry frame is logged at most this often per session. */
const MALFORMED_TELEMETRY_LOG_INTERVAL_MS = 60_000;
const TELEMETRY_FRAME_TYPES: ReadonlySet<string> = new Set([
  "node.info",
  "node.metrics",
  "endpoint.load",
]);
/** Per endpoint/model key; the CLI sends every 2–5 s and on change. */
export const ENDPOINT_LOAD_MIN_INTERVAL_MS = 1_000;
/** Distinct endpoint/model load keys kept per session. */
export const ENDPOINT_LOAD_MAX_KEYS = 1_000;
/** KV-eviction reset (epoch change or prefixCacheReset) at most this often per endpoint. */
export const KV_EVICTION_RESET_DEBOUNCE_MS = 30_000;
/**
 * Bounds the per-endpoint epoch cache. A miss is never read as "unchanged": it costs one
 * durable epoch read, so this bounds memory, not correctness.
 */
export const KV_COUNTER_EPOCH_CACHE_MAX = 16_384;

function addCapped(total: number, delta: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + delta);
}

type LiveEndpointLoadEntry = LiveEndpointLoad & { receivedAtMs: number };

export const DEPLOYMENT_SNAPSHOT_TIMEOUT_MS = 30_000;
const DEPLOYMENT_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEPLOYMENT_SNAPSHOT_RECORDS = 65_536;
const DEPLOYMENT_SNAPSHOT_GLOBAL_BYTES = 32 * 1024 * 1024;
const DEPLOYMENT_SNAPSHOT_SLOTS = 64;
type DeploymentSnapshot = {
  id: string;
  nextIndex: number;
  bytes: number;
  instances: DeploymentObservedInstance[];
  keys: Set<string>;
  completing: boolean;
  released: boolean;
  timer: ReturnType<typeof setTimeout>;
};

type SessionState = {
  socket: RelaySocket;
  identity: CliWebsocketIdentity;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  cliDeviceId: string | null;
  /**
   * The device's connection generation this session was accepted under
   * (from its registration). A disconnect write presents it and is refused
   * once the device has accepted a later connection.
   */
  connectionGeneration: number | null;
  cli: { slug: string } | null;
  registered: boolean;
  /** Serialises `metrics.sources.set` sends: each re-reads the device after the previous one was sent. */
  remoteSourcesQueue: Promise<void>;
  /** Serialises `engine.adapters.set` sends the same way. */
  remoteAdaptersQueue: Promise<void>;
  inventoryConfirmed: boolean;
  /** Connection generation whose complete deployment inventory was committed; null otherwise. */
  deploymentInventoryGeneration: number | null;
  deploymentSnapshot: DeploymentSnapshot | null;
  lastDeploymentSnapshotId: string | null;
  /** Slugs from the last accepted hello / inventory.update. */
  inventorySlugs: Set<string>;
  endpointTargeting: boolean;
  protocolVersion: RelayProtocolVersion | null;
  cliVersion: string | null;
  features: CliReportedFeatures | null;
  terminalPublicKey: string | null;
  /** 2.5 multi-viewer terminals. */
  terminalViewers: boolean;
  /** 2.5 CLI identity proof, relayed to browsers as is. */
  terminalIdentity: CliTerminalIdentity | null;
  allowHumanTerminal: boolean;
  /**
   * Server grant for deployments (dashboard `allowDeployments`). Operator terminals need it
   * (send, attach); revoking it closes the waiting ones (design §12h L5).
   */
  allowDeployments: boolean;
  mcpFileRead: boolean;
  /** Server grant for MCP commands (dashboard). The CLI's own mode is in `features`. */
  mcpCommandMode: McpCommandModeName;
  terminalsById: Map<string, TerminalRecord>;
  commandsById: Map<string, TrackedCliCommand>;
  /** 2.8: in-flight node file ops by op id (answers route only to the session that got the op). */
  filesById: Map<string, TrackedFileOp>;
  /** Supervised commands by command id, from `term.spawn` until their terminal ends. */
  supervisedById: Map<string, TrackedSupervisedCommand>;
  /** Interactive deployment steps with an operator terminal, by step id. */
  operatorSteps: Map<string, OperatorStepTracker>;
  /**
   * Supervised commands whose terminal the server ended, by terminal id,
   * until the CLI's own `term.exit` for it: a `supervised.accepted` still in
   * flight then records that the command had started.
   */
  endingSupervised: Map<string, TrackedSupervisedCommand>;
  unauthenticatedTimer: ReturnType<typeof setTimeout>;
  /** One-shot nonce from `hello.challenge`; consumed when hello is verified. */
  helloNonce: string | null;
  bodyStreamsByRequest: Map<string, OutboundBodyStream>;
  /** 2.7 telemetry, in memory only (see `handleTelemetry`). */
  nodeInfoAcceptedAtMs: number | null;
  nodeMetrics: { sample: Omit<NodeMetricsMessage, "type">; receivedAt: Date } | null;
  nodeMetricsAcceptedAtMs: number | null;
  nodeMetricsPersistedAtMs: number | null;
  endpointLoad: Map<string, LiveEndpointLoadEntry>;
  malformedTelemetryLoggedAtMs: number | null;
  /** Last time a malformed `stt.*` frame from this CLI was logged (rate limit). */
  malformedSttLoggedAtMs: number | null;
  /** Metric routing rule evaluation for this device (S-B part 2). */
  routingEvaluation: RoutingEvaluationState | null;
};

export type ActiveRelayResponseHandlers = {
  /** Called only after request-body bytes have been accepted by the relay socket. */
  onRequestBodySent?(byteLength: number): void;
  /** Count-first Chat: the CLI reports tokenize before headers or a too-large error. */
  onCountResult?(message: CountContextResultMessage): void;
  onCountError?(message: CountContextErrorMessage): void;
  onHeaders(message: Extract<RelayClientControlMessage, { type: "relay.response.headers" }>): void;
  onBody(chunk: Uint8Array, metadata: RelayResponseBodyMetadata): void;
  onComplete(message: Extract<RelayClientControlMessage, { type: "relay.complete" }>): void;
  onError(message: Extract<RelayClientControlMessage, { type: "relay.error" }>): void;
  onCancelled(message: Extract<RelayClientControlMessage, { type: "relay.cancelled" }>): void;
};

export type CountContextResultMessage = Extract<
  RelayClientControlMessage,
  { type: "context.count.result" }
>;
export type CountContextErrorMessage = Extract<
  RelayClientControlMessage,
  { type: "context.count.error" }
>;

type ActiveRelayRequest = ActiveRelayResponseHandlers & {
  cliDeviceId: string;
};

type HelloMessage = Extract<RelayClientControlMessage, { type: "hello" }>;

/** Terminal, exec, and supervised-command capabilities (2.6). */
function interactiveCapabilities(capabilities: HelloMessage["cli"]["capabilities"]): {
  features: CliReportedFeatures;
  terminalPublicKey: string;
  terminalViewers: boolean;
  terminalIdentity: CliTerminalIdentity | null;
} {
  return {
    features: {
      ...capabilities.features,
      fileOps: true,
    },
    terminalPublicKey: capabilities.terminalPublicKey,
    terminalViewers: true,
    terminalIdentity: capabilities.terminalIdentity ?? null,
  };
}

function mintViewerId(terminal?: TerminalRecord): string {
  for (;;) {
    const viewerId = randomBytes(16).toString("base64url");
    if (!terminal || (!terminal.viewers.has(viewerId) && !terminal.pendingViewers.has(viewerId))) {
      return viewerId;
    }
  }
}

/** Distinct browser sockets that hold or wait for this terminal. */
/**
 * A supervised terminal's exit fields from its settled record: the final
 * status, and the command's own exit code or signal when it ran (a review
 * that ends the kept session happens after the command exited).
 */
function supervisedExitFields(supervised: TrackedSupervisedCommand): {
  supervisedStatus: SupervisedTerminalListing["status"];
  exitCode?: number;
  signal?: string;
} {
  const listing = supervised.listing();
  return {
    supervisedStatus: listing.status,
    ...(listing.exitCode !== null ? { exitCode: listing.exitCode } : {}),
    ...(listing.signal !== null ? { signal: listing.signal } : {}),
  };
}

/** Sockets that hear a terminal's exit: its viewers and any tab whose Decline is out. */
function terminalConnIds(terminal: TerminalRecord): string[] {
  const connIds = new Set<string>();
  for (const viewer of terminal.viewers.values()) connIds.add(viewer.connId);
  for (const pending of terminal.pendingViewers.values()) connIds.add(pending.connId);
  for (const connId of terminal.decliners ?? []) connIds.add(connId);
  return [...connIds];
}

/**
 * The (terminal, browser socket) -> viewer id lookup. Derived from the viewer
 * maps, so every path that removes a viewer also removes the lookup entry.
 */
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

/** 2.4 has no term.writer: its single viewer is the writer. */
function terminalWriterViewerId(terminal: TerminalRecord): string | null {
  if (terminal.multiViewer) return terminal.writerViewerId;
  return terminal.viewers.keys().next().value ?? null;
}

function firstEntry<T>(map: Map<string, T>): [string, T] | null {
  return map.entries().next().value ?? null;
}

function reportedFeaturesFromHello(message: HelloMessage, now: Date): ReportedRelayFeatures {
  const features = message.cli.capabilities.features;
  return {
    cliVersion: message.cli.version ?? null,
    relayProtocolVersion: message.protocolVersion,
    reportedHumanTerminal: features.humanTerminal,
    reportedMcpCommandMode: mcpCommandModeToDb(features.mcpCommandMode),
    reportedMcpFileRead: features.mcpFileRead,
    reportedFileRoots: features.fileRootsConfigured,
    reportedTerminalApproval: features.terminalApproval,
    reportedTerminalSupported: features.terminalSupported,
    reportedAllowFileToolsAsRoot: features.allowFileToolsAsRoot,
    reportedDeployments: features.deployments ?? false,
    reportedDeploymentOperator: features.deploymentOperator ?? false,
    reportedHostname: message.cli.hostname ?? null,
    featuresReportedAt: now,
  };
}

function interactiveTargetFromBinary(
  frame: ArrayBuffer,
): { kind: "terminal" | "command" | "supervised" | "file"; id: string } | null {
  if (frame.byteLength < 4) return null;
  const metadataLength = new DataView(frame).getUint32(0, false);
  if (metadataLength > RELAY_JSON_CONTROL_MAX_BYTES || frame.byteLength < 4 + metadataLength) {
    return null;
  }
  try {
    const text = new TextDecoder().decode(new Uint8Array(frame, 4, metadataLength));
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.type === "term.sealed" && typeof record.terminalId === "string") {
      return { kind: "terminal", id: record.terminalId };
    }
    if (
      (record.type === "exec.stdout" || record.type === "exec.stderr") &&
      typeof record.commandId === "string"
    ) {
      return { kind: "command", id: record.commandId };
    }
    if (record.type === "supervised.output" && typeof record.commandId === "string") {
      return { kind: "supervised", id: record.commandId };
    }
    if (record.type === "file.data" && typeof record.opId === "string") {
      return { kind: "file", id: record.opId };
    }
    return null;
  } catch {
    return null;
  }
}

function isSttClientMessage(message: RelayClientControlMessage): message is SttClientMessage {
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
    socket.send(
      encodeRelayServerControlMessage(protocolErrorMessage({ code, message, requestId })),
    );
  }
  socket.close(closeCodeForProtocolError(code), code);
}

function protocolErrorFromRegistration(error: unknown): {
  code: RelayProtocolErrorCode;
  message: string;
} {
  if (error instanceof RelayRegistrationError) {
    if (error.code === "identity_mismatch") {
      return { code: "identity_mismatch", message: error.message };
    }
    if (error.code === "access_denied") {
      return { code: "access_denied", message: error.message };
    }
    return { code: "malformed", message: error.message };
  }
  return { code: "internal", message: "internal" };
}

export class RelaySessionManager {
  private readonly affinityObserverManagerId = randomUUID();
  private affinityObserverTimer: ReturnType<typeof setInterval> | undefined;
  private affinityObserverRunning: Promise<void> | undefined;
  private affinityObserverRecovery: Promise<void> | undefined;
  private pendingAffinityResets = new Map<
    string,
    {
      cliDeviceId: string;
      connectionGeneration: number;
      slug: string;
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
  private deploymentSnapshotBytes = 0;
  private deploymentSnapshotSlots = 0;
  private deploymentHandlers: {
    result(socket: DeploymentSocket, result: DeploymentJobResult): Promise<unknown>;
    inventory(socket: DeploymentSocket, instances: DeploymentObservedInstance[]): Promise<unknown>;
    /** Called once a session is dispatch-ready (its inventory committed for this generation). */
    ready?(socket: DeploymentSocket): void;
  } | null = null;
  setDeploymentHandlers(handlers: typeof this.deploymentHandlers) {
    this.deploymentHandlers = handlers;
  }
  deploymentSocket(cliDeviceId: string): DeploymentLiveSocket | null {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (this.relayDrain || !session?.registered || session.connectionGeneration === null)
      return null;
    return {
      cliDeviceId,
      userId: session.identity.userId,
      generation: session.connectionGeneration,
      // Inventory counts only for the generation that committed it; an in-place generation
      // change (a newer hello settled under this session) requires fresh inventory.
      inventoryComplete: session.deploymentInventoryGeneration === session.connectionGeneration,
      // The reconciler claims interactive steps only where the send below would go through.
      deploymentOperator: this.deploymentTerminalPolicyAllows(session),
      operatorRoom:
        session.operatorSteps.size < OPERATOR_STEPS_PER_SESSION ||
        [...session.operatorSteps.values()].some((tracker) => tracker.cancelled),
    };
  }
  sendDeploymentJob(socket: DeploymentSocket, job: DeploymentJob) {
    const session = this.sessionsByCliDeviceId.get(socket.cliDeviceId);
    if (
      this.relayDrain ||
      !session?.registered ||
      session.connectionGeneration !== socket.generation ||
      session.identity.userId !== socket.userId ||
      // A closing socket would drop the frame silently; report it unsent.
      session.socket.readyState !== WS_READY_STATE_OPEN ||
      // Interactive jobs reach only a CLI that reported it can run them.
      (deploymentJobNeedsOperator(job) && !this.sessionRunsOperatorJobs(session))
    )
      return false;
    if (job.operator !== undefined) return this.sendOperatorJob(session, socket, job);
    try {
      this.sendControl(session, job);
      return true;
    } catch {
      return false;
    }
  }
  private sessionRunsOperatorJobs(session: SessionState) {
    return deploymentOperatorSupported({
      protocolVersion: session.protocolVersion,
      deployments: session.features?.deployments,
      deploymentOperator: session.features?.deploymentOperator,
    });
  }

  /**
   * Whether this node may hold operator terminals the owner can attach to:
   * the deployment operator capability plus browser terminal crypto. NOT the
   * human-terminal grant or the MCP command mode (design §5, §11.5). The
   * node owner's opt-in (U1, design §12i: a separate node-local switch, off by
   * default) is enforced by the CLI: it reports `deploymentOperator` only
   * while that switch, deployments and a PTY are all on, and re-checks the
   * switch at attach. The server's view is the hello snapshot.
   */
  private deploymentTerminalPolicyAllows(session: SessionState): boolean {
    return (
      // The dashboard grant too (design §12h L5): revoking it blocks sends and attaches.
      session.allowDeployments &&
      this.sessionRunsOperatorJobs(session) &&
      session.features?.terminalSupported === true &&
      session.terminalPublicKey !== null
    );
  }

  /**
   * Send an interactive job and pre-register its operator terminal (origin
   * `deployment`, phase `opening`; listed once `awaiting_operator` names it).
   * A repeated send of the same terminal for the same step re-sends the job and
   * keeps the record (the CLI re-reports its state). A new terminal for a step
   * replaces the old one: the CLI closes it itself on the new job. Terminal ids
   * are never reused: an id held by any other terminal refuses the send.
   */
  private sendOperatorJob(session: SessionState, socket: DeploymentSocket, job: DeploymentJob) {
    const operator = job.operator;
    if (
      operator === undefined ||
      job.interactive !== true ||
      !isDeploymentOperatorAction(job.action) ||
      !this.deploymentTerminalPolicyAllows(session)
    )
      return false;
    const terminalId = operator.terminalId;
    const previous = session.operatorSteps.get(job.stepId);
    const repeat =
      previous !== undefined &&
      previous.terminalId === terminalId &&
      !previous.cancelled &&
      previous.intentHash === job.intentHash &&
      previous.ownerEpoch === job.ownerEpoch &&
      previous.instanceId === job.instanceId &&
      previous.rank === job.rank &&
      // An ended terminal is never reopened under its id (the CLI would spawn a
      // new one): a re-dispatch after `term.exit` needs a freshly minted id.
      session.terminalsById.get(terminalId)?.origin === "deployment";
    // At the cap a cancelled tracker gives way, but only once the send succeeded:
    // until then it still routes the CLI's answer to the server's own close.
    let evict: OperatorStepTracker | null = null;
    if (!repeat) {
      if (this.hasTerminal(terminalId) || this.operatorTerminalIdTracked(terminalId)) return false;
      if (previous === undefined && session.operatorSteps.size >= OPERATOR_STEPS_PER_SESSION) {
        evict = [...session.operatorSteps.values()].find((tracker) => tracker.cancelled) ?? null;
        if (evict === null) return false;
      }
    }
    let frame: string;
    try {
      // Encoded first: a job the CLI could not read throws here, before
      // anything is registered or sent.
      frame = encodeRelayServerControlMessage(job);
    } catch {
      return false;
    }
    try {
      session.socket.send(frame);
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
      action: job.action,
      intentHash: job.intentHash,
      ownerEpoch: job.ownerEpoch,
      terminalId,
      userId: socket.userId,
      cliDeviceId: socket.cliDeviceId,
      phase: "spawning",
      attempted: false,
      cancelled: false,
    });
    session.terminalsById.set(terminalId, {
      terminalId,
      userId: socket.userId,
      cliDeviceId: socket.cliDeviceId,
      cols: 80,
      rows: 24,
      multiViewer: true,
      viewers: new Map(),
      pendingViewers: new Map(),
      writerViewerId: null,
      phase: "opening",
      createdAt: Date.now(),
      origin: "deployment",
      supervised: null,
      deployment: {
        stepId: job.stepId,
        instanceId: job.instanceId,
        rank: job.rank,
        action: job.action,
        state: "awaiting",
      },
    });
    return true;
  }

  private operatorTerminalIdTracked(terminalId: string): boolean {
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const tracker of session.operatorSteps.values()) {
        if (tracker.terminalId === terminalId) return true;
      }
    }
    return false;
  }

  private recordOperatorEvent(
    tracker: OperatorStepTracker,
    outcome: DeploymentOperatorOutcome,
    exitCode?: number,
  ) {
    recordDeploymentOperatorEvent({
      userId: tracker.userId,
      instanceId: tracker.instanceId,
      stepId: tracker.stepId,
      cliDeviceId: tracker.cliDeviceId,
      rank: tracker.rank,
      action: tracker.action,
      outcome,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
  }

  /**
   * A new terminal replaced this step's terminal: forget the old one and end
   * its record (viewers see the exit). The CLI closes the old terminal itself
   * when it takes the new job; `closed` is recorded when it had opened.
   */
  private replaceOperatorStep(session: SessionState, tracker: OperatorStepTracker) {
    if (session.operatorSteps.get(tracker.stepId) === tracker)
      session.operatorSteps.delete(tracker.stepId);
    if (tracker.phase !== "spawning" && !tracker.cancelled)
      this.recordOperatorEvent(tracker, "closed");
    const terminal = session.terminalsById.get(tracker.terminalId);
    if (terminal?.origin === "deployment") this.closeTerminal(session, terminal, false);
  }

  /**
   * Operator progress (`awaiting_operator`, `operator_running`,
   * `operator_closed`) for this session. Only progress naming the terminal
   * this session sent for exactly that step (id, intent hash, owner epoch,
   * instance, rank) is passed on; anything else is dropped, and a live
   * terminal nobody tracks is closed on the CLI. Writes the audit rows.
   * Returns whether the result goes on to the reconciler.
   */
  private observeOperatorProgress(session: SessionState, result: DeploymentJobResult): boolean {
    const terminalId = result.terminalId;
    if (terminalId === undefined) return false;
    const tracker = session.operatorSteps.get(result.stepId);
    const matches =
      tracker !== undefined &&
      tracker.terminalId === terminalId &&
      tracker.intentHash === result.intentHash &&
      tracker.ownerEpoch === result.ownerEpoch &&
      tracker.instanceId === result.instanceId &&
      tracker.rank === result.rank;
    if (!matches || tracker === undefined) {
      // A terminal this session no longer tracks (replaced, or never sent)
      // must not stay open on its CLI. A tracked one stays: a mismatched
      // (stale) frame naming it is only dropped. Only this session's state is
      // consulted, so a CLI learns nothing about other sessions' terminals.
      if (
        result.status !== "operator_closed" &&
        !session.terminalsById.has(terminalId) &&
        ![...session.operatorSteps.values()].some((other) => other.terminalId === terminalId) &&
        session.socket.readyState === WS_READY_STATE_OPEN
      )
        this.sendControl(session, { type: "term.close", terminalId });
      return false;
    }
    if (tracker.cancelled) {
      // Only the CLI's answer to the server's own close still matters. A
      // terminal that spawned after that close reached the CLI is closed again.
      if (result.status === "operator_closed") {
        session.operatorSteps.delete(tracker.stepId);
        return true;
      }
      if (session.socket.readyState === WS_READY_STATE_OPEN)
        this.sendControl(session, { type: "term.close", terminalId });
      return false;
    }
    const terminal = session.terminalsById.get(terminalId);
    const record = terminal?.origin === "deployment" ? terminal : undefined;
    if (result.status === "awaiting_operator") {
      if (tracker.phase === "spawning") this.recordOperatorEvent(tracker, "opened");
      // An attempt ended without success (exit code n != 0); the person may retry.
      else if (tracker.phase === "running") this.recordOperatorEvent(tracker, "failed");
      tracker.phase = "awaiting";
      if (record?.deployment) {
        record.phase = "open";
        record.deployment.state = "awaiting";
        this.notifyTerminalListChanged(record.userId);
      }
      return true;
    }
    if (result.status === "operator_running") {
      if (tracker.phase === "spawning") return false;
      if (tracker.phase === "awaiting") this.recordOperatorEvent(tracker, "accepted");
      tracker.phase = "running";
      tracker.attempted = true;
      if (record?.deployment && record.deployment.state !== "running") {
        record.deployment.state = "running";
        this.notifyTerminalListChanged(record.userId);
      }
      return true;
    }
    // operator_closed: declined (nothing ran), or the terminal ended without success.
    session.operatorSteps.delete(tracker.stepId);
    if (tracker.phase !== "spawning") {
      if (result.exitCode !== undefined || tracker.attempted || tracker.phase === "running")
        this.recordOperatorEvent(tracker, "closed", result.exitCode);
      else this.recordOperatorEvent(tracker, "declined");
    }
    if (record) this.closeTerminal(session, record, false);
    return true;
  }

  /**
   * A final result (`succeeded` / `failed`) for a tracked interactive step:
   * `succeeded`/`failed` when its terminal had been opened, `auto_settled`
   * when the CLI's status-first check settled a step nobody ran. A failure
   * before any terminal opened (spawn refused) records nothing.
   */
  private observeOperatorFinal(session: SessionState, result: DeploymentJobResult) {
    if (result.status !== "succeeded" && result.status !== "failed") return;
    const tracker = session.operatorSteps.get(result.stepId);
    if (
      tracker === undefined ||
      // A final names its dispatch's terminal: a late answer to an earlier copy of the step
      // must not end (or be audited against) the current terminal.
      tracker.terminalId !== result.terminalId ||
      tracker.intentHash !== result.intentHash ||
      tracker.ownerEpoch !== result.ownerEpoch ||
      tracker.instanceId !== result.instanceId ||
      tracker.rank !== result.rank
    )
      return;
    session.operatorSteps.delete(tracker.stepId);
    // Recorded even after a server cancel: a verify that won the race is the truth.
    if (tracker.phase !== "spawning")
      this.recordOperatorEvent(tracker, result.status === "succeeded" ? "succeeded" : "failed");
    else if (result.status === "succeeded") this.recordOperatorEvent(tracker, "auto_settled");
    const terminal = session.terminalsById.get(tracker.terminalId);
    // The CLI ends the terminal before it verifies; a record still here is stale.
    if (terminal?.origin === "deployment") this.closeTerminal(session, terminal, true);
  }

  /**
   * Close the operator terminal of a deployment step, by step id (design
   * §12b: a step reset to PENDING loses its stored terminal id). Any session
   * holding the step is searched. Records `cancelled` when the terminal had
   * opened. `keepRunning` leaves a terminal whose command already runs alone
   * (answer `running`). The CLI's `operator_closed` answer still reaches the
   * reconciler.
   */
  closeDeploymentOperatorStep(
    stepId: string,
    options: { keepRunning?: boolean } = {},
  ): "closed" | "running" | "absent" {
    for (const session of this.sessionsByCliDeviceId.values()) {
      const tracker = session.operatorSteps.get(stepId);
      if (tracker === undefined || tracker.cancelled) continue;
      if (options.keepRunning === true && tracker.phase === "running") return "running";
      this.cancelOperatorStep(session, tracker);
      return "closed";
    }
    return "absent";
  }

  /** Ban fence: close every operator terminal of this user (see `./user-ban.ts`). */
  cancelDeploymentOperatorTerminalsForUser(userId: string) {
    for (const session of this.sessionsByCliDeviceId.values()) {
      if (session.identity.userId !== userId) continue;
      for (const tracker of [...session.operatorSteps.values()]) {
        if (!tracker.cancelled) this.cancelOperatorStep(session, tracker);
      }
    }
  }

  private cancelOperatorStep(session: SessionState, tracker: OperatorStepTracker) {
    if (tracker.phase !== "spawning") this.recordOperatorEvent(tracker, "cancelled");
    tracker.cancelled = true;
    const terminal = session.terminalsById.get(tracker.terminalId);
    if (terminal?.origin === "deployment") this.closeTerminal(session, terminal, true);
    else if (session.socket.readyState === WS_READY_STATE_OPEN)
      this.sendControl(session, { type: "term.close", terminalId: tracker.terminalId });
  }

  /** The session ended: its operator terminals are gone with it. */
  private endOperatorSteps(session: SessionState) {
    for (const tracker of [...session.operatorSteps.values()]) {
      session.operatorSteps.delete(tracker.stepId);
      if (tracker.phase !== "spawning" && !tracker.cancelled)
        this.recordOperatorEvent(tracker, "closed");
    }
  }
  private sessionsBySocket = new Map<RelaySocket, SessionState>();
  private sessionsByCliDeviceId = new Map<string, SessionState>();
  /** Manager-level so a reconnect does not wipe the 30-minute ring. */
  private engineLoadHistory = new EngineLoadHistoryStore();
  /** Last `counterEpoch` per (device, endpoint). Survives reconnect of this process. */
  private kvCounterEpochByEndpoint = new Map<string, number>();
  /** Last KV-eviction reset time per (device, endpoint), for debounce. */
  private kvResetAtByEndpoint = new Map<string, number>();
  private featureGrantsRefreshByCliDeviceId = new Map<string, Promise<void>>();
  private grantChangeSeq = 0;
  // One integer per device changed since process start. There is no device-delete
  // policy hook; retain the fence even while offline so delayed hellos stay fenced.
  private lastGrantChangeSeq = new Map<string, number>();
  /**
   * Highest connection generation this process has installed or settled per
   * device. Hello results can complete out of order, so an older-committed
   * hello may resume after a newer one was detached and settled while no owner
   * was installed; this remembers that the newer generation exists so the
   * older one is not installed over it. Bounded (oldest entries evicted).
   */
  private latestGenerationByCliDeviceId = new Map<string, number>();
  private activeRelayRequests = new Map<string, ActiveRelayRequest>();
  /**
   * Shutdown drain flag, shared by the relay and the browser terminal hub.
   * Set by {@link beginDrain} (the HTTP drain's `stopAdmission`, index.ts) and
   * again by {@link closeIdleRelaySessions} / {@link closeRelaySessions};
   * one-way: nothing clears it, because the process exits after shutdown.
   * While set:
   * - new CLI relay upgrades (./websocket.ts) and new browser terminal
   *   upgrades (`createTerminalWebsocketMiddleware`, ./terminal-websocket.ts)
   *   answer 503 before authentication;
   * - no new model request is sent to a CLI (`sendRelayRequest` throws) and no
   *   supervised command starts (`startSupervisedCommand` returns false);
   * - a CLI socket closes once its last model request finishes
   *   ({@link considerDrainClose}).
   * - a CLI socket whose authentication finished after the drain began is
   *   closed on open and never registered ({@link acceptAuthenticatedSocket});
   * It does not close sockets already upgraded: browser terminal sockets are
   * closed by the hub's `closeAll` (the shutdown's `closeBrowserSockets`
   * step) and CLI sockets by the close calls above.
   */
  private relayDrain = false;
  /** Live speech-to-text sessions; each registered CLI session is one link. */
  private readonly stt = new SttRelayHub({
    resolveLink: (cliDeviceId, endpointSlug) => this.resolveSttLink(cliDeviceId, endpointSlug),
    // During drain, the CLI socket closes once its last live session ended
    // (deferred: the hub is mid-operation when it calls this).
    onLinkIdle: (link) => {
      if (!this.relayDrain) return;
      queueMicrotask(() => this.considerDrainClose(link.cliDeviceId));
    },
  });
  private readonly sttLinks = new WeakMap<SessionState, SttRelayLink>();
  private readonly routingEvaluator = new MetricRoutingEvaluator();
  private readonly poolMemberRecovery = new PoolMemberRecoveryScheduler({
    getOwnedCliDeviceIds: () => this.getActiveCliDeviceIds(),
    listDueMembers: listDueOwnedPoolMemberRecoveries,
    probe: (member) => this.probeOwnedPoolMember(member),
  });

  /**
   * Registers an upgraded, authenticated CLI socket. The single admission
   * point for the drain: the upgrade middleware checks {@link relayDrain}
   * before its awaited authentication, so a socket whose authentication
   * finishes after the drain began arrives here. It is closed with the
   * shutdown close code and never registered. Returns whether it was accepted.
   */
  acceptAuthenticatedSocket({
    socket,
    identity,
    now = new Date(),
  }: {
    socket: RelaySocket;
    identity: CliWebsocketIdentity;
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
        this.removeSession(socket, new Date());
      }
    }, RELAY_UNREGISTERED_STALE_AFTER_MS);

    this.sessionsBySocket.set(socket, {
      socket,
      identity,
      connectedAt: now,
      lastHeartbeatAt: now,
      cliDeviceId: null,
      connectionGeneration: null,
      cli: null,
      registered: false,
      remoteSourcesQueue: Promise.resolve(),
      remoteAdaptersQueue: Promise.resolve(),
      inventoryConfirmed: false,
      deploymentInventoryGeneration: null,
      deploymentSnapshot: null,
      lastDeploymentSnapshotId: null,
      inventorySlugs: new Set(),
      endpointTargeting: false,
      protocolVersion: null,
      cliVersion: null,
      features: null,
      terminalPublicKey: null,
      terminalViewers: false,
      terminalIdentity: null,
      allowHumanTerminal: false,
      allowDeployments: false,
      mcpCommandMode: "off",
      mcpFileRead: false,
      terminalsById: new Map(),
      commandsById: new Map(),
      filesById: new Map(),
      supervisedById: new Map(),
      operatorSteps: new Map(),
      endingSupervised: new Map(),
      unauthenticatedTimer,
      helloNonce,
      bodyStreamsByRequest: new Map(),
      nodeInfoAcceptedAtMs: null,
      nodeMetrics: null,
      nodeMetricsAcceptedAtMs: null,
      nodeMetricsPersistedAtMs: null,
      endpointLoad: new Map(),
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

  async handleTextFrame(socket: RelaySocket, frame: string, now = new Date()) {
    const session = this.requireSession(socket);
    // A hello that is not the minimum protocol gets a message it can print
    // (an "upgrade wsmp" text), not an opaque schema rejection. Every released CLI treats protocol.error as fatal.
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
      await this.recordRejectedHello(session, rejected, now);
      await this.removeSession(socket, now);
      return;
    }
    let message: RelayClientControlMessage;
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
      const nonce = session.helloNonce;
      session.helloNonce = null;
      if (
        !nonce ||
        !verifyHelloIdentitySignature({
          identityPublicKey: message.cli.identityPublicKey,
          signature: message.cli.identitySignature,
          nonce,
          cliSlug: message.cli.slug,
          origin: relayHelloOrigin(),
        })
      ) {
        closeWithProtocolError(socket, "malformed", "Hello identity proof is invalid.");
        await this.removeSession(socket, now);
        return;
      }
      try {
        const helloSeq = this.grantChangeSeq;
        const registration = await persistRelayRegistration({
          identity: session.identity,
          cli: message.cli,
          endpoints: message.endpoints,
          inventoryConfirmed: true,
          endpointTargeting: true,
          connection: true,
          reported: reportedFeaturesFromHello(message, now),
          identityPublicKey: message.cli.identityPublicKey,
          now,
        });
        if (this.sessionsBySocket.get(socket) !== session) {
          // Detached while registration ran (socket closed, or its credential
          // revoked / device deleted). The registration committed CONNECTED
          // for a session that no longer exists: do not route to it, and put
          // the device status back unless another live session owns it.
          await this.settleDetachedRegistration(
            registration.cliDeviceId,
            now,
            registration.connectionGeneration,
          );
          return;
        }
        const installed = this.sessionsByCliDeviceId.get(registration.cliDeviceId);
        const knownGeneration = Math.max(
          installed && installed !== session ? (installed.connectionGeneration ?? 0) : 0,
          this.latestGenerationByCliDeviceId.get(registration.cliDeviceId) ?? 0,
        );
        if (knownGeneration > registration.connectionGeneration) {
          // Hello results can complete out of order: a later-committed hello
          // already owns the device. This older one is superseded; it must
          // not replace the newer owner (whose durable fence is higher, so its
          // own disconnect would then be refused with no session serving the
          // device). No await between this check and the install below.
          this.sessionsBySocket.delete(socket);
          clearTimeout(session.unauthenticatedTimer);
          if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
          socket.close(1000, "replaced");
          return;
        }
        this.noteConnectionGeneration(registration.cliDeviceId, registration.connectionGeneration);
        session.cliDeviceId = registration.cliDeviceId;
        session.connectionGeneration = registration.connectionGeneration;
        session.cli = { slug: message.cli.slug };
        session.registered = true;
        session.inventoryConfirmed = true;
        session.endpointTargeting = true;
        session.protocolVersion = message.protocolVersion;
        session.cliVersion = message.cli.version ?? null;
        // Registration can commit before a policy change but return after its
        // refresh. Check and install without yielding: an old hello gets no
        // authority until the same device queue establishes current policy.
        const stalePolicy = this.featureGrantChangeSeq(registration.cliDeviceId) > helloSeq;
        this.installSessionFeatureGrants(
          session,
          stalePolicy
            ? {
                allowHumanTerminal: false,
                allowDeployments: false,
                mcpCommandMode: "off",
                mcpFileRead: false,
              }
            : registration,
        );
        const interactive = interactiveCapabilities(message.cli.capabilities);
        session.features = interactive.features;
        session.terminalPublicKey = interactive.terminalPublicKey;
        session.terminalViewers = interactive.terminalViewers;
        session.terminalIdentity = interactive.terminalIdentity;
        session.lastHeartbeatAt = now;
        if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
        session.routingEvaluation = createRoutingEvaluationState(
          session.identity.userId,
          registration.cliDeviceId,
        );
        clearTimeout(session.unauthenticatedTimer);
        this.reconcileInteractiveGrants(session);
        this.replaceDuplicateSession(session);
        session.inventorySlugs = new Set(message.endpoints.map((endpoint) => endpoint.slug));
        this.pruneCounterEpochs(registration.cliDeviceId, session.inventorySlugs);
        if (stalePolicy) {
          void this.refreshFeatureGrants(registration.cliDeviceId).catch((error: unknown) => {
            console.error(
              "[relay] stale hello policy refresh failed",
              error instanceof Error ? error.name : typeof error,
            );
          });
        }
        // Members opened only by this device's disconnect are probed now, not
        // after the disconnect cooldown. Best effort: on failure the normal
        // scheduled retry still recovers them.
        await markPoolMembersDueAfterCliReconnect({
          cliDeviceId: registration.cliDeviceId,
          now: new Date(),
        }).catch(() => 0);
        this.poolMemberRecovery.wake();
        await registerAffinityObservers({
          cliDeviceId: registration.cliDeviceId,
          slugs: [...session.inventorySlugs],
          connectionGeneration: registration.connectionGeneration,
          managerId: this.affinityObserverManagerId,
        }).catch(() => {});
        this.startAffinityObserverMaintenance();
        socket.send(
          encodeRelayServerControlMessage({
            type: "hello.ok",
            id: message.id,
            protocolVersion: message.protocolVersion,
            revision: registration.revision,
            desiredCapabilities: registration.desiredCapabilities,
          }),
        );
        await this.seedCounterEpochs(registration.cliDeviceId);
        await this.sendRemoteMetricSources(session);
        await this.sendRemoteEngineAdapters(session);
      } catch (error) {
        // Already detached and closed by whoever detached it.
        if (this.sessionsBySocket.get(socket) !== session) return;
        // An identity-key mismatch rolls the registration back, so the session
        // already serving this device stays. The message tells the copy to
        // log in again; it is not an opaque protocol error.
        if (error instanceof RelayRegistrationError && error.code === "identity_mismatch") {
          await this.recordIdentityRefusal(session.identity, now);
        }
        const mapped = protocolErrorFromRegistration(error);
        closeWithProtocolError(socket, mapped.code, mapped.message, message.id);
        await this.removeSession(socket, now);
      }
      return;
    }

    if (!session.registered || !session.cliDeviceId) {
      closeWithProtocolError(
        socket,
        "malformed",
        "Registration is required before relay messages.",
      );
      await this.removeSession(socket, now);
      return;
    }

    if (message.type === "inventory.update" && session.cli) {
      if (!session.endpointTargeting && message.endpoints.length > 1) {
        socket.send(
          encodeRelayServerControlMessage({
            type: "inventory.error",
            id: message.id,
            message:
              "Legacy relay clients may publish only one endpoint; upgrade wsmp for multi-endpoint routing.",
          }),
        );
        return;
      }
      try {
        const registration = await persistRelayRegistration({
          identity: session.identity,
          cli: session.cli,
          endpoints: message.endpoints,
          inventoryConfirmed: session.inventoryConfirmed,
          endpointTargeting: session.endpointTargeting,
          now,
        });
        // Detached during the write: nothing to acknowledge. An inventory
        // update never writes connection state, so there is nothing to undo.
        if (this.sessionsBySocket.get(socket) !== session) return;
        session.inventorySlugs = new Set(message.endpoints.map((endpoint) => endpoint.slug));
        this.pruneCounterEpochs(registration.cliDeviceId, session.inventorySlugs);
        const sttLink = this.sttLinks.get(session);
        if (sttLink) this.stt.endpointsChanged(sttLink, session.inventorySlugs);
        socket.send(
          encodeRelayServerControlMessage({
            type: "inventory.ok",
            id: message.id,
            revision: registration.revision,
            desiredCapabilities: registration.desiredCapabilities,
          }),
        );
      } catch (error) {
        if (this.sessionsBySocket.get(socket) !== session) return;
        if (error instanceof RelayRegistrationError && error.code === "access_denied") {
          // The credential was revoked (or its owner removed) since the hello.
          socket.send(
            encodeRelayServerControlMessage(
              protocolErrorMessage({
                code: "access_denied",
                message: "access_denied",
                requestId: message.id,
              }),
            ),
          );
          socket.close(1008, "access_denied");
          await this.removeSession(socket, now);
          return;
        }
        const messageText =
          error instanceof RelayRegistrationError ? error.message : "inventory update failed";
        socket.send(
          encodeRelayServerControlMessage({
            type: "inventory.error",
            id: message.id,
            message: messageText,
          }),
        );
      }
      return;
    }

    if (message.type === "deployment.job.result" || message.type === "deployment.instances") {
      const current = this.sessionsByCliDeviceId.get(session.cliDeviceId);
      if (current !== session || session.connectionGeneration === null) return;
      const identity = {
        cliDeviceId: session.cliDeviceId,
        userId: session.identity.userId,
        generation: session.connectionGeneration,
      };
      if (message.type === "deployment.job.result") {
        // Operator progress answers only interactive jobs, which only a CLI that
        // reported `deploymentOperator` is ever sent.
        if (deploymentOperatorResultStatus(message.status)) {
          if (!this.sessionRunsOperatorJobs(session)) return;
          // Only progress for the operator terminal this session sent goes on.
          if (!this.observeOperatorProgress(session, message)) return;
        } else this.observeOperatorFinal(session, message);
        await this.deploymentHandlers?.result(identity, message);
      } else await this.receiveDeploymentSnapshot(session, identity, message, frame);
      return;
    }

    if (message.type === "heartbeat") {
      session.lastHeartbeatAt = now;
      // Same durable fence as the disconnect: a heartbeat only refreshes the
      // row while it still describes THIS session's connection (its
      // generation, and not already disconnected/stale). A heartbeat whose
      // dispatch was delayed past its own detach, or past a successor's
      // registration, matches nothing instead of resurrecting CONNECTED.
      // Fail closed: a session with no claimed generation writes nothing.
      const generation = session.connectionGeneration;
      if (generation !== null && Number.isInteger(generation) && generation >= 1)
        await prisma.cliDevice.updateMany({
          where: { id: session.cliDeviceId, connectionGeneration: generation, status: "CONNECTED" },
          data: { lastHeartbeatAt: now },
        });
      socket.send(
        encodeRelayServerControlMessage({
          type: "heartbeat.pong",
          id: message.id,
          receivedAt: now.toISOString(),
        }),
      );
      return;
    }

    if (
      message.type === "node.info" ||
      message.type === "node.metrics" ||
      message.type === "endpoint.load"
    ) {
      await this.handleTelemetry(session, message, now);
      return;
    }

    if (message.type === "relay.request.body.ack") {
      this.grantBodyCredits(session, message.requestId, message.credits);
      return;
    }

    if (message.type === "relay.response.headers") {
      this.ownedRelayRequest(session, message.requestId)?.onHeaders(message);
      return;
    }

    if (message.type === "relay.complete") {
      const activeRequest = this.takeOwnedRelayRequest(session, message.requestId);
      if (!activeRequest) return;
      activeRequest.onComplete(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
      return;
    }

    if (message.type === "relay.error") {
      const activeRequest = this.takeOwnedRelayRequest(session, message.requestId);
      if (!activeRequest) return;
      activeRequest.onError(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
      return;
    }

    if (message.type === "relay.cancelled") {
      const activeRequest = this.takeOwnedRelayRequest(session, message.requestId);
      if (!activeRequest) return;
      activeRequest.onCancelled(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
      return;
    }

    if (message.type === "context.count.result") {
      this.ownedRelayRequest(session, message.requestId)?.onCountResult?.(message);
      return;
    }

    if (message.type === "context.count.error") {
      this.ownedRelayRequest(session, message.requestId)?.onCountError?.(message);
      return;
    }

    if (
      message.type === "term.pending" ||
      message.type === "term.opened" ||
      message.type === "term.attached" ||
      message.type === "term.rejected" ||
      message.type === "term.writer" ||
      message.type === "term.input_dropped" ||
      message.type === "term.exit"
    ) {
      this.handleTerminalControl(session, message);
      return;
    }

    if (
      message.type === "exec.started" ||
      message.type === "exec.rejected" ||
      message.type === "exec.done"
    ) {
      this.handleExecControl(session, message);
      return;
    }

    if (message.type === "file.result" || message.type === "file.rejected") {
      this.handleFileControl(session, message);
      return;
    }

    // 2.4 live speech-to-text. Frames for sessions this CLI does not hold
    // (late, or another CLI's) are dropped.
    if (isSttClientMessage(message)) {
      if (session.cliDeviceId) this.stt.handleClientFrame(this.sttLinkFor(session), message);
      return;
    }

    if (
      message.type === "term.spawned" ||
      message.type === "supervised.rejected" ||
      message.type === "supervised.accepted" ||
      message.type === "supervised.declined" ||
      message.type === "supervised.done"
    ) {
      this.handleSupervisedControl(session, message);
    }
  }

  handleBinaryFrame(socket: RelaySocket, frame: ArrayBuffer) {
    try {
      const session = this.sessionsBySocket.get(socket);
      if (!session) return;
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
      if (parsed.metadata.type === "exec.stdout" || parsed.metadata.type === "exec.stderr") {
        const command = session.commandsById.get(parsed.metadata.commandId);
        if (!command) return;
        if (command.status !== "running") return;
        command.appendOutput(
          parsed.metadata.type === "exec.stdout" ? "stdout" : "stderr",
          parsed.body,
        );
        return;
      }
      if (parsed.metadata.type === "file.data") {
        // Only the session that got the op may answer it; anything else is dropped.
        session.filesById.get(parsed.metadata.opId)?.markData(parsed.body);
        return;
      }
      if (parsed.metadata.type === "file.body" || parsed.metadata.type === "stt.audio") {
        // Server to CLI only. A CLI has no business sending it.
        return;
      }
      if (parsed.metadata.type === "supervised.output") {
        // The record keeps it only when output was requested and the command
        // has exited without review (see `onOutput`).
        session.supervisedById
          .get(parsed.metadata.commandId)
          ?.onOutput(parsed.metadata.part, parsed.body);
      }
    } catch (error) {
      const target = interactiveTargetFromBinary(frame);
      if (target?.kind === "terminal") {
        const session = this.sessionsBySocket.get(socket);
        const terminal = session?.terminalsById.get(target.id);
        if (session && terminal) this.closeTerminal(session, terminal, false);
      } else if (target?.kind === "command") {
        const session = this.sessionsBySocket.get(socket);
        const command = session?.commandsById.get(target.id);
        if (session && command?.status === "running") this.cancelTrackedCommand(session, command);
      } else if (target?.kind === "file") {
        // A malformed answer fails that op only; the session stays.
        this.sessionsBySocket.get(socket)?.filesById.get(target.id)?.markMalformed();
      } else if (target?.kind === "supervised") {
        const session = this.sessionsBySocket.get(socket);
        const supervised = session?.supervisedById.get(target.id);
        const terminal = supervised ? session?.terminalsById.get(supervised.terminalId) : undefined;
        if (session && terminal) this.closeTerminal(session, terminal, true, "closed");
      }
      console.error(
        "[relay] binary frame rejected",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    }
  }

  async removeSession(socket: RelaySocket, now = new Date()) {
    await this.removeSessionWithStatus(socket, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
    });
  }

  /** Stops background recovery in controlled shutdowns and unit tests. */
  dispose() {
    this.stopAffinityResetRecovery();
    this.poolMemberRecovery.stop();
    for (const session of this.sessionsBySocket.values()) {
      this.clearDeploymentSnapshot(session);
      session.deploymentInventoryGeneration = null;
      if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
    }
  }

  private stopAffinityResetRecovery() {
    this.affinityResetClosed = true;
    clearInterval(this.affinityResetTimer);
    clearInterval(this.affinityObserverTimer);
    for (const job of this.pendingAffinityResets.values()) job.release();
    this.pendingAffinityResets.clear();
  }

  private async removeSessionWithStatus(
    socket: RelaySocket,
    {
      now,
      cliStatus,
      failureClass,
    }: {
      now: Date;
      cliStatus: "DISCONNECTED" | "STALE";
      failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
    },
  ) {
    await this.detachSession(socket, { now, cliStatus, failureClass })?.();
  }

  /**
   * Drops the session from memory right away and returns its database write,
   * if any. Shutdown detaches every socket before it awaits a single write, so
   * a slow database cannot keep later sockets open.
   */
  private clearDeploymentSnapshot(session: SessionState) {
    const snapshot = session.deploymentSnapshot;
    if (!snapshot) return;
    clearTimeout(snapshot.timer);
    // The callback still owns its array after disconnect/timeout; keep that memory charged until it joins.
    if (!snapshot.completing) this.releaseDeploymentSnapshot(snapshot);
    session.deploymentSnapshot = null;
  }

  private releaseDeploymentSnapshot(snapshot: DeploymentSnapshot) {
    if (snapshot.released) return;
    snapshot.released = true;
    this.deploymentSnapshotBytes -= snapshot.bytes;
    this.deploymentSnapshotSlots--;
  }

  private async receiveDeploymentSnapshot(
    session: SessionState,
    identity: DeploymentSocket,
    frame: DeploymentInstancesFrame,
    encoded: string,
  ) {
    const reject = async () => {
      session.deploymentInventoryGeneration = null;
      this.clearDeploymentSnapshot(session);
      closeWithProtocolError(session.socket, "malformed", "Invalid deployment inventory snapshot.");
      await this.removeSession(session.socket, new Date());
    };
    let snapshot = session.deploymentSnapshot;
    if (frame.chunkIndex === 0) {
      // A fresh start replaces an incomplete snapshot; never a committing callback.
      session.deploymentInventoryGeneration = null;
      if (
        snapshot?.completing ||
        snapshot?.id === frame.snapshotId ||
        session.lastDeploymentSnapshotId === frame.snapshotId
      )
        return reject();
      this.clearDeploymentSnapshot(session);
      if (this.deploymentSnapshotSlots >= DEPLOYMENT_SNAPSHOT_SLOTS) return reject();
      const timer = setTimeout(() => {
        if (session.deploymentSnapshot !== snapshot) return;
        const code = snapshot?.completing ? "internal" : "malformed";
        session.deploymentInventoryGeneration = null;
        this.clearDeploymentSnapshot(session);
        closeWithProtocolError(session.socket, code, "Deployment inventory snapshot timed out.");
        void this.removeSession(session.socket, new Date()).catch(() => {});
      }, DEPLOYMENT_SNAPSHOT_TIMEOUT_MS);
      timer.unref();
      snapshot = {
        id: frame.snapshotId,
        nextIndex: 0,
        bytes: 0,
        instances: [],
        keys: new Set(),
        completing: false,
        released: false,
        timer,
      };
      session.deploymentSnapshot = snapshot;
      this.deploymentSnapshotSlots++;
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (
      !snapshot ||
      snapshot.completing ||
      snapshot.id !== frame.snapshotId ||
      snapshot.nextIndex !== frame.chunkIndex ||
      snapshot.bytes + bytes > DEPLOYMENT_SNAPSHOT_BYTES ||
      this.deploymentSnapshotBytes + bytes > DEPLOYMENT_SNAPSHOT_GLOBAL_BYTES ||
      snapshot.instances.length + frame.instances.length > DEPLOYMENT_SNAPSHOT_RECORDS
    )
      return reject();
    for (const instance of frame.instances) {
      const key = `${instance.instanceId}:${instance.rank}`;
      if (snapshot.keys.has(key)) return reject();
      snapshot.keys.add(key);
    }
    snapshot.bytes += bytes;
    this.deploymentSnapshotBytes += bytes;
    snapshot.nextIndex++;
    snapshot.instances.push(...frame.instances);
    if (!frame.final) return;
    snapshot.completing = true;
    try {
      if (!this.deploymentHandlers) throw new Error("deployment_inventory_handler_missing");
      const accepted = await this.deploymentHandlers.inventory(identity, snapshot.instances);
      if (accepted === false) throw new Error("deployment_inventory_not_committed");
      if (
        accepted !== false &&
        this.sessionsByCliDeviceId.get(identity.cliDeviceId) === session &&
        session.deploymentSnapshot === snapshot
      ) {
        session.lastDeploymentSnapshotId = snapshot.id;
        session.deploymentInventoryGeneration = identity.generation;
        session.socket.send(
          encodeRelayServerControlMessage({
            type: "deployment.instances.ok",
            snapshotId: snapshot.id,
          }),
        );
        this.deploymentHandlers.ready?.(identity);
      }
    } catch {
      session.deploymentInventoryGeneration = null;
      closeWithProtocolError(
        session.socket,
        "internal",
        "Deployment inventory could not be committed.",
      );
      await this.removeSession(session.socket, new Date());
    } finally {
      if (session.deploymentSnapshot === snapshot) this.clearDeploymentSnapshot(session);
      this.releaseDeploymentSnapshot(snapshot);
    }
    // ACK is emitted only by the current generation after durable completion.
    // A rejected/timed-out/detached callback never acknowledges its snapshot.
  }

  private detachSession(
    socket: RelaySocket,
    {
      now,
      cliStatus,
      failureClass,
    }: {
      now: Date;
      cliStatus: "DISCONNECTED" | "STALE";
      failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
    },
  ): (() => Promise<void>) | null {
    const session = this.sessionsBySocket.get(socket);
    if (!session) return null;
    this.clearDeploymentSnapshot(session);
    session.deploymentInventoryGeneration = null;
    this.teardownInteractiveWork(session);
    clearTimeout(session.unauthenticatedTimer);
    if (session.routingEvaluation) this.routingEvaluator.cancel(session.routingEvaluation);
    this.sessionsBySocket.delete(socket);
    this.failActiveRequestsForSession(session);
    this.failSttSessions(session);
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId || this.sessionsByCliDeviceId.get(cliDeviceId) !== session) return null;
    this.sessionsByCliDeviceId.delete(cliDeviceId);
    const connectionGeneration = session.connectionGeneration;
    return () =>
      this.writeDeviceDisconnected(cliDeviceId, {
        now,
        cliStatus,
        failureClass,
        connectionGeneration,
      });
  }

  /**
   * Persists that no session serves this device. `updateMany` because the
   * device may have been deleted (its sessions are closed right after).
   *
   * Durable-ownership fence: both writes carry `connectionGeneration`, the
   * generation the detached session was accepted under. A hello that commits
   * after the detach increments it and makes every write below match nothing,
   * so a stale close can never overwrite the status or pool-member health of a
   * live successor — including a successor on another replica, which this
   * process cannot see in `sessionsByCliDeviceId`.
   */
  private async writeDeviceDisconnected(
    cliDeviceId: string,
    {
      now,
      cliStatus,
      failureClass,
      connectionGeneration,
    }: {
      now: Date;
      cliStatus: "DISCONNECTED" | "STALE";
      failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
      connectionGeneration: number | null;
    },
  ) {
    // Never pass `undefined` to a Prisma filter: it would drop the key and
    // remove the fence. Fail closed on anything but a real generation, so a
    // session that never registered (or a registration that did not report
    // one) writes nothing instead of an unfenced disconnect.
    if (
      connectionGeneration === null ||
      !Number.isInteger(connectionGeneration) ||
      connectionGeneration < 1
    )
      return;
    const applied = await disconnectCliDeviceAtGeneration({
      cliDeviceId,
      generation: connectionGeneration,
      cliStatus,
      failureClass,
      now,
    });
    if (applied) this.poolMemberRecovery.wake();
  }

  /**
   * A hello's registration committed (device CONNECTED) after its session was
   * detached. The session never entered routing; undo the connected status
   * unless another live session now owns the device (its own registration
   * wrote CONNECTED and routing points at it).
   *
   * The write is fenced by the registration's own generation: any successor —
   * in this process or another replica — has incremented the stored generation
   * and this write matches no row (the row is left as the successor wrote it).
   *
   * In-memory fast path: a live owner here was accepted under an OLDER
   * generation than this registration (generations follow commit order, owners
   * follow hello-processing order), so this commit superseded the owner's
   * fence. The owner adopts the higher generation; otherwise its own later
   * disconnect would match no row and the device would stay CONNECTED with no
   * session. Adoption never lowers a generation, and a later hello (any
   * replica) still increments past it.
   */
  private noteConnectionGeneration(cliDeviceId: string, generation: number) {
    const known = this.latestGenerationByCliDeviceId.get(cliDeviceId) ?? 0;
    if (generation <= known) return;
    // Re-insert so eviction (oldest first) tracks recency.
    this.latestGenerationByCliDeviceId.delete(cliDeviceId);
    this.latestGenerationByCliDeviceId.set(cliDeviceId, generation);
    if (this.latestGenerationByCliDeviceId.size > 4096) {
      const oldest = this.latestGenerationByCliDeviceId.keys().next().value;
      if (oldest !== undefined) this.latestGenerationByCliDeviceId.delete(oldest);
    }
  }

  private async settleDetachedRegistration(
    cliDeviceId: string,
    now: Date,
    connectionGeneration: number,
  ) {
    this.noteConnectionGeneration(cliDeviceId, connectionGeneration);
    const owner = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (owner) {
      if ((owner.connectionGeneration ?? 0) < connectionGeneration)
        owner.connectionGeneration = connectionGeneration;
      return;
    }
    await this.writeDeviceDisconnected(cliDeviceId, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
      connectionGeneration,
    });
  }

  async checkStaleSessions(now = new Date()) {
    const staleSessions = [...this.sessionsBySocket.values()].filter(
      (session) =>
        session.registered &&
        session.cliDeviceId &&
        now.getTime() - session.lastHeartbeatAt.getTime() > RELAY_STALE_AFTER_MS,
    );
    for (const session of staleSessions) {
      this.teardownInteractiveWork(session);
      session.socket.close(1001, "stale");
      await this.removeSessionWithStatus(session.socket, {
        now,
        cliStatus: "STALE",
        failureClass: "STALE_SESSION",
      });
    }
  }

  /**
   * Start of HTTP drain. New relay work is refused. Sockets with no in-flight
   * model request are closed now so they cannot hold `server.close()`. A socket
   * that still has a request stays up until that request finishes or the drain
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

  /**
   * Refuse new relay and terminal sockets (see {@link relayDrain}). Synchronous
   * so shutdown can stop admission first. Idempotent and never undone.
   */
  beginDrain() {
    this.relayDrain = true;
    this.stopAffinityResetRecovery();
    // Live transcription streams cannot be resumed and would hold their CLI
    // sockets through the whole HTTP drain: they end now (clients reconnect).
    this.stt.closeAll();
  }

  isDraining(): boolean {
    return this.relayDrain;
  }

  /** Shutdown step: cancel interactive work, close remaining CLI sockets, mark devices disconnected. */
  async closeRelaySessions(now = new Date()) {
    this.beginDrain();
    // Live sessions end first, while the CLI sockets can still carry `stt.close`.
    this.stt.closeAll();
    await Promise.allSettled([...this.affinityResetWrites]);
    await this.shutdownRelaySessions([...this.sessionsBySocket.values()], now);
  }

  private async shutdownRelaySessions(sessions: SessionState[], now: Date) {
    // Close every socket first. Only then touch the database.
    let failure: unknown;
    const recordFailure = (error: unknown) => {
      failure = error;
      console.error(
        "[relay] closeRelaySessions failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
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
    return this.detachSession(session.socket, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
    });
  }

  private sessionHasActiveRelayWork(session: SessionState): boolean {
    if (session.bodyStreamsByRequest.size > 0) return true;
    const sttLink = this.sttLinks.get(session);
    if (sttLink && this.stt.hasActiveLegs(sttLink)) return true;
    if (!session.cliDeviceId) return false;
    for (const active of this.activeRelayRequests.values()) {
      if (active.cliDeviceId === session.cliDeviceId) return true;
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
    if (!active || active.cliDeviceId !== session.cliDeviceId) return undefined;
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

  /** During drain, close a CLI socket once its last model request has finished. */
  private considerDrainClose(cliDeviceId: string | null | undefined) {
    if (!this.relayDrain || !cliDeviceId) return;
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session || this.sessionHasActiveRelayWork(session)) return;
    void (async () => {
      await this.shutdownRelaySession(session, new Date())?.();
    })().catch((error: unknown) => {
      console.error(
        "[relay] idle session close failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    });
  }

  onCliFeatureGrantsChanged(cliDeviceId: string): Promise<void> {
    this.lastGrantChangeSeq.set(cliDeviceId, ++this.grantChangeSeq);
    return this.refreshFeatureGrants(cliDeviceId);
  }

  /** Fence an admission before its first read; compare again at its sync verdict. */
  featureGrantChangeSeq(cliDeviceId: string): number {
    return this.lastGrantChangeSeq.get(cliDeviceId) ?? 0;
  }

  private async refreshFeatureGrants(cliDeviceId: string) {
    // Post-commit notifications and stale hello recovery share this queue.
    // Own the per-device queue
    // through the read, apply and metric push; different devices stay independent.
    // A failed tail must not poison the next refresh or leave an idle entry.
    const previous = this.featureGrantsRefreshByCliDeviceId.get(cliDeviceId);
    const refresh = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        try {
          const device = await prisma.cliDevice.findUnique({
            where: { id: cliDeviceId },
            select: {
              allowHumanTerminal: true,
              allowDeployments: true,
              mcpCommandMode: true,
              mcpFileRead: true,
            },
          });
          this.applyFeatureGrants(cliDeviceId, {
            allowHumanTerminal: device?.allowHumanTerminal === true,
            allowDeployments: device?.allowDeployments === true,
            mcpCommandMode: device ? mcpCommandModeFromDb(device.mcpCommandMode) : "off",
            mcpFileRead: device?.mcpFileRead === true,
          });
        } catch (error) {
          // Unknown committed policy cannot retain old authority, including
          // unsupervised access. Reconciliation cancels work before we rethrow.
          this.applyFeatureGrants(cliDeviceId, {
            allowHumanTerminal: false,
            allowDeployments: false,
            mcpCommandMode: "off",
            mcpFileRead: false,
          });
          throw error;
        } finally {
          // Leaving `unsupervised` withdraws remote metric sources at once, even
          // when the grant read above failed: the push re-reads the committed
          // mode itself and fails closed (an empty list) on any error.
          await this.onRemoteMetricSourcesChanged(cliDeviceId);
          await this.onRemoteEngineAdaptersChanged(cliDeviceId);
        }
      });
    this.featureGrantsRefreshByCliDeviceId.set(cliDeviceId, refresh);
    try {
      await refresh;
    } finally {
      if (this.featureGrantsRefreshByCliDeviceId.get(cliDeviceId) === refresh) {
        this.featureGrantsRefreshByCliDeviceId.delete(cliDeviceId);
      }
    }
  }

  /**
   * Closes every relay socket, registered or not, that authenticated with one
   * of these credentials. Called after the revocation commits (re-login
   * reattach, CLI token revoke, device or user deletion). Websocket auth
   * refuses the revoked secret from then on, and registration re-checks it
   * inside its transaction, so a socket that authenticated just before the
   * commit but opened after this call is refused at its hello. A hello whose
   * registration was in flight when its socket was closed here does not enter
   * routing (see the hello handler's detach check).
   *
   * Per-process: sockets held by another server replica are not reached here;
   * they are refused at their next hello or inventory update.
   */
  async closeSessionsForRevokedCredentials(
    revoked: { kind: CliWebsocketIdentity["kind"]; ids: readonly string[] },
    now = new Date(),
  ) {
    if (revoked.ids.length === 0) return;
    const ids = new Set(revoked.ids);
    await this.closeSessionsMatching(
      (session) => session.identity.kind === revoked.kind && ids.has(session.identity.id),
      now,
    );
  }

  /**
   * Closes every relay socket, registered or not, whose authenticated
   * identity belongs to a user that was just deleted. Matched by
   * `identity.userId` (every live session carries it), not by a credential-id
   * snapshot, so a credential minted between any snapshot and the delete is
   * covered too. Called after the user row's delete committed, through
   * `@ws-model-proxy/auth/user-deletion-listeners`, by every user-delete
   * path: the dashboard `users.remove` procedure, Better Auth's
   * `user.delete.before` hook (which performs the delete itself) and the
   * user-deletion sweeper that finishes a pending delete.
   *
   * Also called when a deletion is marked (`onUserDeletionMarked`), before
   * the user row is gone.
   *
   * Per-process: sockets held by another replica are not reached here. From
   * the mark on, credential authentication and relay registration refuse the
   * user (`userCredentialAccessBlocked`), so that replica refuses them at the
   * next hello or inventory update and websocket auth refuses any reconnect;
   * the credential rows cascade with the user once the deletion completes.
   * Same exception in this process for CLI relay sockets only: a registration
   * whose owner check read the user before the mark and whose in-memory
   * register runs after this close leaves a live socket. It grants the owner
   * nothing (every model, MCP and command admission re-reads the marker) and
   * is refused at its next hello or inventory update. Browser terminal
   * sockets have no such exception: they register (pending) before their
   * admission read, so `TerminalBrowserHub.revokeTerminalAccessForUser`
   * closes every one that is registered, and a later one's read sees the
   * mark (see `admitBrowserConnection`). Relay identities are CLI
   * credentials owned by `userId`; impersonation (Better Auth
   * `session.impersonatedBy`) exists only on browser sessions.
   */
  async closeSessionsForUser(userId: string, now = new Date()) {
    const deviceIds = new Set<string>();
    for (const session of this.sessionsByCliDeviceId.values()) {
      if (session.identity.userId === userId && session.cliDeviceId) {
        deviceIds.add(session.cliDeviceId);
      }
    }
    await this.closeSessionsMatching((session) => session.identity.userId === userId, now);
    for (const cliDeviceId of deviceIds) this.engineLoadHistory.dropDevice(cliDeviceId);
  }

  private async closeSessionsMatching(matches: (session: SessionState) => boolean, now: Date) {
    const sessions = [...this.sessionsBySocket.values()].filter(matches);
    // Close and detach every matching socket before any database write, so a
    // failed or slow status write cannot leave a later socket open.
    const writes: Array<() => Promise<void>> = [];
    for (const session of sessions) {
      this.teardownInteractiveWork(session);
      if (session.socket.readyState === WS_READY_STATE_OPEN) {
        session.socket.send(
          encodeRelayServerControlMessage(
            protocolErrorMessage({ code: "access_denied", message: "access_denied" }),
          ),
        );
        session.socket.close(1008, "access_denied");
      }
      const write = this.detachSession(session.socket, {
        now,
        cliStatus: "DISCONNECTED",
        failureClass: "WEBSOCKET_DISCONNECTED",
      });
      if (write) writes.push(write);
    }
    for (const write of writes) {
      try {
        await write();
      } catch (error) {
        console.error(
          "[relay] revoked session status write failed",
          error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
        );
      }
    }
  }

  applyFeatureGrants(
    cliDeviceId: string,
    grants: {
      allowHumanTerminal: boolean;
      /** Absent: the deployments grant is unchanged. */
      allowDeployments?: boolean;
      mcpCommandMode: McpCommandModeName;
      mcpFileRead: boolean;
    },
  ) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return;
    this.installSessionFeatureGrants(session, grants);
    this.reconcileInteractiveGrants(session);
  }

  /** The only installer for established session policy; callers never await here. */
  private installSessionFeatureGrants(
    session: SessionState,
    grants: {
      allowHumanTerminal: boolean;
      allowDeployments?: boolean;
      mcpCommandMode: McpCommandModeName;
      mcpFileRead: boolean;
    },
  ) {
    session.allowHumanTerminal = grants.allowHumanTerminal;
    if (grants.allowDeployments !== undefined) session.allowDeployments = grants.allowDeployments;
    session.mcpCommandMode = grants.mcpCommandMode;
    session.mcpFileRead = grants.mcpFileRead === true;
  }

  /**
   * Seed last-seen `counterEpoch` from durable endpoint rows so a replica or
   * reboot still resets KV evidence only on a real epoch change.
   */
  private async seedCounterEpochs(cliDeviceId: string) {
    try {
      const rows = await prisma.endpoint.findMany({
        where: { cliDeviceId },
        select: { slug: true, loadCounterEpoch: true },
      });
      for (const row of rows ?? []) {
        if (row.loadCounterEpoch == null) continue;
        const key = `${cliDeviceId}\0${row.slug}`;
        if (!this.kvCounterEpochByEndpoint.has(key))
          this.kvCounterEpochByEndpoint.set(key, row.loadCounterEpoch);
      }
    } catch (error) {
      console.error(
        "[relay] seeding load counter epochs failed",
        error instanceof Error ? error.name : typeof error,
      );
    }
  }

  private startAffinityObserverMaintenance() {
    this.affinityObserverTimer ??= setInterval(() => {
      if (this.affinityResetClosed || this.affinityObserverRunning) return;
      this.affinityObserverRunning = (async () => {
        try {
          await renewAffinityObservers(
            this.affinityObserverManagerId,
            [...this.sessionsByCliDeviceId.keys()],
            [...this.pendingAffinityResets.values()].map(
              (job) => `${job.cliDeviceId}\u0001${job.slug}`,
            ),
          );
        } catch {
          // Database-clock lease expiry suppresses confidence without stopping inference.
        }
      })().finally(() => {
        this.affinityObserverRunning = undefined;
      });
      this.affinityResetWrites.add(this.affinityObserverRunning);
      const running = this.affinityObserverRunning;
      void running.finally(() => this.affinityResetWrites.delete(running));
      if (!this.affinityObserverRecovery) {
        this.affinityObserverRecovery = (async () => {
          await recoverAffinityObservers();
          if (!this.affinityResetClosed)
            await discoverAffinityObservers(
              this.affinityObserverManagerId,
              [...this.sessionsByCliDeviceId.keys()],
              [...this.pendingAffinityResets.values()].map(
                (job) => `${job.cliDeviceId}\u0001${job.slug}`,
              ),
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

  private pruneCounterEpochs(cliDeviceId: string, slugs: ReadonlySet<string>) {
    const prefix = `${cliDeviceId}\0`;
    for (const key of this.kvCounterEpochByEndpoint.keys()) {
      if (key.startsWith(prefix) && !slugs.has(key.slice(prefix.length))) {
        this.kvCounterEpochByEndpoint.delete(key);
        this.kvResetAtByEndpoint.delete(key);
      }
    }
    while (this.kvCounterEpochByEndpoint.size > KV_COUNTER_EPOCH_CACHE_MAX) {
      const first = this.kvCounterEpochByEndpoint.keys().next().value;
      if (first === undefined) break;
      this.kvCounterEpochByEndpoint.delete(first);
      this.kvResetAtByEndpoint.delete(first);
    }
  }

  /**
   * Record an identity-key refusal on the credential or token after the
   * registration transaction has rolled back, so the dashboard can show it.
   */
  private async recordIdentityRefusal(identity: CliWebsocketIdentity, now: Date) {
    const data = { lastRefusedAt: now, lastRefusedReason: "identity_mismatch" };
    try {
      if (identity.kind === "deviceCredential") {
        await prisma.cliDeviceCredential.updateMany({ where: { id: identity.id }, data });
      } else {
        await prisma.cliToken.updateMany({ where: { id: identity.id }, data });
      }
    } catch (error) {
      console.error(
        "[relay] recording an identity refusal failed",
        error instanceof Error ? error.name : typeof error,
      );
    }
  }

  /**
   * Remember why a device's CLI was refused so its card can say "CLI upgrade
   * required", or "Server upgrade required" when the claimed protocol is newer
   * than this server speaks. Only a credential already bound to a device
   * identifies it; an unbound token has no device yet (the relay log above has
   * the versions).
   */
  private async recordRejectedHello(
    session: SessionState,
    rejected: { protocolVersion: string | null; cliVersion: string | null },
    now: Date,
  ) {
    const cliDeviceId = session.identity.cliDeviceId;
    if (!cliDeviceId) return;
    try {
      await prisma.cliDevice.updateMany({
        where: { id: cliDeviceId, userId: session.identity.userId },
        data: {
          rejectedRelayProtocolVersion: rejected.protocolVersion,
          rejectedCliVersion: rejected.cliVersion,
          relayRejectedAt: now,
        },
      });
    } catch (error) {
      console.error(
        "[relay] recording a refused hello failed",
        error instanceof Error ? error.name : typeof error,
      );
    }
  }

  /**
   * Reset KV-eviction evidence on a `counterEpoch` change or an explicit `prefixCacheReset`.
   * Hello must not wipe rows. Unknown inventory slugs are ignored.
   *
   * Only positive proof skips work: a cached epoch equal to the frame's. A missing cache entry
   * (eviction, pruning) is resolved against the durable epoch, and repeated explicit resets
   * inside the debounce window are coalesced into one delayed reset rather than dropped.
   */
  private async noteKvEvictionResetSignal(
    session: SessionState,
    load: Pick<EndpointLoadMessage, "endpointSlug" | "prefixCacheReset" | "counterEpoch">,
    now: Date,
  ) {
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId || !session.inventorySlugs.has(load.endpointSlug)) return;
    const key = `${cliDeviceId}\0${load.endpointSlug}`;
    if (this.affinityResetClosed) return;
    const previousEpoch = this.kvCounterEpochByEndpoint.get(key);
    const epochUnknown = previousEpoch === undefined;
    const epochChanged = !epochUnknown && load.counterEpoch !== previousEpoch;
    const lastResetMs = this.kvResetAtByEndpoint.get(key);
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
      // Least-recently-used: an endpoint that keeps reporting stays cached.
      this.kvCounterEpochByEndpoint.delete(key);
      this.kvCounterEpochByEndpoint.set(key, load.counterEpoch);
      return;
    }
    try {
      const existing = this.pendingAffinityResets.get(key);
      if (existing) {
        // New reset evidence supersedes an in-flight snapshot: its completion may not clear
        // this newer fence, even when the signal was rate-dropped. Evidence is judged against
        // the pending job, not the (stale until it completes) cache: any epoch movement is a
        // reset, and frames repeating the job's epoch leave it alone so it can complete.
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
          cliDeviceId,
          connectionGeneration: session.connectionGeneration ?? 0,
          slug: load.endpointSlug,
          epoch: load.counterEpoch,
          reset: resetRequested,
          epochUnknown,
          notBefore,
          now,
          version: 0,
          release: beginAffinityReset(cliDeviceId, load.endpointSlug, session.identity.userId),
        });
      }
    } catch {
      // Only bounded observation-ledger overload relinquishes a connection;
      // ordinary metadata persistence failures preserve all serving streams.
      session.socket.close(1011, "cache_generation_unavailable");
      await this.removeSession(session.socket, now);
      return;
    }
    this.affinityResetTimer ??= setInterval(() => {
      if (this.affinityResetClosed || this.affinityResetRecoveryRunning) return;
      this.affinityResetRecoveryRunning = true;
      void (async () => {
        // At most four due jobs each tick; rotation prevents a locked first endpoint from
        // monopolizing quiet recovery, and delayed (debounced) jobs never crowd out due ones.
        const nowMs = Date.now();
        const due = [...this.pendingAffinityResets.entries()]
          .filter(([, job]) => job.notBefore <= nowMs && !job.running)
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
    const { cliDeviceId, connectionGeneration, slug, epoch, epochUnknown, now, version } = job;
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
            (await readAffinityCounterEpoch(cliDeviceId, slug).then((durable) =>
              // A CLI process starts each endpoint's counters at epoch 0. With
              // nothing stored yet, a later epoch means a reset this server may
              // not have seen (one sent while the slug was still being
              // inventoried), so it is treated as one; epoch 0 is a baseline.
              durable === null ? epoch > 0 : durable !== epoch,
            )));
        const observations = reset
          ? await observeAffinityReset({
              cliDeviceId,
              slugs: [slug],
              connectionGeneration,
              managerId: this.affinityObserverManagerId,
            })
          : [];
        if (reset) await resetKvEvictionForEndpoint(cliDeviceId, slug, now);
        await persistAffinityCounterEpoch(cliDeviceId, slug, epoch);
        if (this.affinityResetClosed || job.version !== version) return;
        await acknowledgeAffinityObservations(observations);
        if (this.affinityResetClosed || job.version !== version) return;
        this.kvCounterEpochByEndpoint.set(key, epoch);
        while (this.kvCounterEpochByEndpoint.size > KV_COUNTER_EPOCH_CACHE_MAX) {
          const first = this.kvCounterEpochByEndpoint.keys().next().value;
          if (first === undefined) break;
          this.kvCounterEpochByEndpoint.delete(first);
          this.kvResetAtByEndpoint.delete(first);
        }
        if (reset && Number.isFinite(now.getTime()))
          this.kvResetAtByEndpoint.set(key, now.getTime());
        job.release();
        this.pendingAffinityResets.delete(key);
      } catch {
        // The affected physical capacity remains unknown until durable intent
        // and epoch consumption both commit. Ordinary routing is unaffected.
      } finally {
        job.running = undefined;
      }
    })();
    const running = job.running;
    this.affinityResetWrites.add(running);
    void running.finally(() => this.affinityResetWrites.delete(running));
    return running;
  }

  /**
   * 2.7 telemetry. Frames above the rate limits are dropped, never fatal.
   * `endpoint.load` and the freshest metrics stay in memory; the CliDevice
   * row gets `node.info` once per connection and a metrics snapshot at most
   * once a minute.
   */
  private async handleTelemetry(
    session: SessionState,
    message: NodeInfoMessage | NodeMetricsMessage | EndpointLoadMessage,
    now: Date,
  ) {
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId) return;
    const nowMs = now.getTime();
    if (message.type === "endpoint.load") {
      const { type: _type, ...load } = message;
      // Reset evidence is evaluated for every frame before any lossy load bookkeeping (rate
      // limit, key cap): a dropped reading must never drop a physical cache reset.
      await this.noteKvEvictionResetSignal(session, load, now);
      const key = `${load.endpointSlug}\u0000${load.modelSlug ?? ""}`;
      const previous = session.endpointLoad.get(key);
      const hitsDelta = load.prefixCacheHitsDelta ?? 0;
      const queriesDelta = load.prefixCacheQueriesDelta ?? 0;
      if (previous && nowMs - previous.receivedAtMs < ENDPOINT_LOAD_MIN_INTERVAL_MS) {
        // The reading is dropped but its counter deltas are not.
        previous.prefixCacheHitsTotal = addCapped(previous.prefixCacheHitsTotal, hitsDelta);
        previous.prefixCacheQueriesTotal = addCapped(
          previous.prefixCacheQueriesTotal,
          queriesDelta,
        );
        return;
      }
      if (!previous && session.endpointLoad.size >= ENDPOINT_LOAD_MAX_KEYS) return;
      // "Sustained" waiting counts consecutive accepted frames. A gap longer
      // than the staleness window restarts the count (fail open).
      const continuous = previous && nowMs - previous.receivedAtMs <= ENDPOINT_LOAD_STALE_AFTER_MS;
      const waitingStreak =
        load.waiting != null && load.waiting > 0
          ? (continuous ? previous.waitingStreak : 0) + 1
          : 0;
      session.endpointLoad.set(key, {
        ...load,
        modelSlug: load.modelSlug ?? null,
        waitingStreak,
        prefixCacheHitsTotal: addCapped(previous?.prefixCacheHitsTotal ?? 0, hitsDelta),
        prefixCacheQueriesTotal: addCapped(previous?.prefixCacheQueriesTotal ?? 0, queriesDelta),
        receivedAt: now,
        receivedAtMs: nowMs,
      });
      this.engineLoadHistory.record(cliDeviceId, load.endpointSlug, load.modelSlug ?? null, {
        running: load.running,
        waiting: load.waiting,
        kvUsage: load.kvUsage,
        kvOccupancy: load.kvOccupancy,
        slotsBusy: load.slotsBusy,
        prefixCacheHitsDelta: hitsDelta,
        prefixCacheQueriesDelta: queriesDelta,
        source: load.source,
        receivedAt: now,
      });
      observeEngineLoadRollup({
        ownerUserId: session.identity.userId,
        cliDeviceId,
        endpointSlug: load.endpointSlug,
        modelSlug: load.modelSlug ?? null,
        receivedAt: now,
        running: load.running,
        waiting: load.waiting,
        kvUsage: load.kvUsage,
        kvOccupancy: load.kvOccupancy,
        slotsBusy: load.slotsBusy,
        prefixCacheHitsDelta: hitsDelta,
        prefixCacheQueriesDelta: queriesDelta,
        source: load.source,
      });
      this.scheduleRoutingEvaluation(session);
      return;
    }
    if (message.type === "node.info") {
      if (
        session.nodeInfoAcceptedAtMs !== null &&
        nowMs - session.nodeInfoAcceptedAtMs < NODE_INFO_MIN_INTERVAL_MS
      ) {
        return;
      }
      session.nodeInfoAcceptedAtMs = nowMs;
      const { type: _type, ...info } = message;
      await this.writeTelemetry(cliDeviceId, { nodeInfo: info, nodeInfoAt: now });
      return;
    }
    if (
      session.nodeMetricsAcceptedAtMs !== null &&
      nowMs - session.nodeMetricsAcceptedAtMs < NODE_METRICS_MIN_INTERVAL_MS
    ) {
      return;
    }
    session.nodeMetricsAcceptedAtMs = nowMs;
    const { type: _type, ...sample } = message;
    session.nodeMetrics = { sample, receivedAt: now };
    const gpuTemps = (sample.gpus ?? []).map((gpu) => gpu.temperatureC);
    const gpuUtils = (sample.gpus ?? []).map((gpu) => gpu.utilizationPercent);
    observeNodeMetricsRollup({
      ownerUserId: session.identity.userId,
      cliDeviceId,
      receivedAt: now,
      cpuPercent: sample.cpu?.usagePercent,
      memoryAvailableMiB: sample.memory?.availableMiB,
      memoryTotalMiB: sample.memory?.totalMiB,
      gpuTemperatureC: gpuTemps.reduce<number | null>(
        (max, value) => (value == null ? max : max == null ? value : Math.max(max, value)),
        null,
      ),
      gpuUtilizationPercent: gpuUtils.reduce<number | null>(
        (max, value) => (value == null ? max : max == null ? value : Math.max(max, value)),
        null,
      ),
    });
    this.scheduleRoutingEvaluation(session);
    if (
      session.nodeMetricsPersistedAtMs !== null &&
      nowMs - session.nodeMetricsPersistedAtMs < NODE_METRICS_PERSIST_INTERVAL_MS
    ) {
      return;
    }
    session.nodeMetricsPersistedAtMs = nowMs;
    await this.writeTelemetry(
      cliDeviceId,
      { nodeMetrics: sample, nodeMetricsAt: now },
      // Per device, not per session: a snapshot stored by an earlier session
      // (or another server instance) inside the window keeps this one out,
      // and an older delayed write never replaces a newer snapshot.
      {
        OR: [
          { nodeMetricsAt: null },
          { nodeMetricsAt: { lte: new Date(nowMs - NODE_METRICS_PERSIST_INTERVAL_MS) } },
        ],
      },
    );
  }

  private scheduleRoutingEvaluation(session: SessionState) {
    const state = session.routingEvaluation;
    if (!state) return;
    this.routingEvaluator.schedule(state, () => ({
      nodeMetrics: session.nodeMetrics,
      endpointLoad: [...session.endpointLoad.values()],
    }));
  }

  /**
   * Send the device's remotely defined metric sources (`metrics.sources.set`)
   * to its live session: after `hello.ok`, and whenever the definitions or the
   * device's MCP command mode change. Only an `unsupervised` device gets its
   * definitions; any other mode gets an empty list, which stops them. The CLI
   * still needs its local opt-in and a hash approval of each command.
   */
  private sendRemoteMetricSources(session: SessionState): Promise<boolean> {
    // One send at a time per session, each reading the device only when its
    // turn comes: the last send always reflects the newest committed mode
    // and definitions, so an older read can never overtake a withdrawal.
    const turn = session.remoteSourcesQueue.then(() => this.sendRemoteMetricSourcesNow(session));
    session.remoteSourcesQueue = turn.then(() => undefined);
    return turn;
  }

  /**
   * Never rejects (it logs and returns), so the queue never stalls. Fails
   * closed: whatever goes wrong before the device's grant and definitions
   * are known (read error, missing or foreign device, invalid stored list),
   * the CLI is sent an EMPTY list, which stops every remote source; only a
   * successful read of an `unsupervised` device sends definitions. Returns
   * true only when the intended list was sent.
   */
  private async sendRemoteMetricSourcesNow(session: SessionState): Promise<boolean> {
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId) return false;
    let sources: RemoteMetricSource[] = [];
    let intended = false;
    try {
      const device = await prisma.cliDevice.findUnique({
        where: { id: cliDeviceId },
        select: { userId: true, mcpCommandMode: true, remoteMetricSources: true },
      });
      if (device && device.userId === session.identity.userId) {
        // The outbound list is validated against the relay 2.7 wire schema
        // (strict entries, at most NODE_METRIC_SOURCES_MAX). Anything that
        // fails is withheld: the CLI gets an empty list, never a malformed
        // or oversized frame.
        const wire = remoteMetricSourcesSchema.safeParse(
          device.mcpCommandMode === "UNSUPERVISED"
            ? parseStoredRemoteMetricSources(device.remoteMetricSources)
            : [],
        );
        if (wire.success) {
          sources = wire.data;
          intended = true;
        } else {
          console.error(
            "[relay] stored remote metric sources failed the wire schema; sending none",
          );
        }
      }
    } catch (error) {
      console.error(
        "[relay] reading remote metric sources failed; withdrawing them",
        error instanceof Error ? error.name : typeof error,
      );
    }
    if (this.sessionsByCliDeviceId.get(cliDeviceId) !== session) return false;
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    try {
      session.socket.send(
        encodeRelayServerControlMessage({
          type: "metrics.sources.set",
          id: `sources-${randomBytes(8).toString("hex")}`,
          sources,
        }),
      );
      return intended;
    } catch (error) {
      console.error(
        "[relay] sending remote metric sources failed",
        error instanceof Error ? error.name : typeof error,
      );
      return false;
    }
  }

  /** A pool's metric routing rules were replaced: clear its stored verdicts. */
  async onPoolRoutingRulesChanged(poolId: string): Promise<void> {
    await this.routingEvaluator.clearPool(poolId);
  }

  /** The dashboard or MCP changed a device's remote metric sources. */
  async onRemoteMetricSourcesChanged(cliDeviceId: string) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session?.registered) return false;
    return await this.sendRemoteMetricSources(session);
  }

  /**
   * Send the device's remotely defined engine adapters (`engine.adapters.set`)
   * to its live 2.9 session. Only an `unsupervised` device gets definitions;
   * any other mode gets an empty list. The CLI still needs its separate
   * local opt-in and a hash approval of each canonical spec.
   */
  private sendRemoteEngineAdapters(session: SessionState): Promise<boolean> {
    const turn = session.remoteAdaptersQueue.then(() => this.sendRemoteEngineAdaptersNow(session));
    session.remoteAdaptersQueue = turn.then(() => undefined);
    return turn;
  }

  private async sendRemoteEngineAdaptersNow(session: SessionState): Promise<boolean> {
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId) return false;
    let adapters: RemoteEngineAdapter[] = [];
    let intended = false;
    try {
      const device = await prisma.cliDevice.findUnique({
        where: { id: cliDeviceId },
        select: { userId: true, mcpCommandMode: true, remoteEngineAdapters: true },
      });
      if (device && device.userId === session.identity.userId) {
        const wire = remoteEngineAdaptersSchema.safeParse(
          device.mcpCommandMode === "UNSUPERVISED"
            ? parseStoredRemoteEngineAdapters(device.remoteEngineAdapters)
            : [],
        );
        if (wire.success) {
          adapters = wire.data;
          intended = true;
        } else {
          console.error(
            "[relay] stored remote engine adapters failed the wire schema; sending none",
          );
        }
      }
    } catch (error) {
      console.error(
        "[relay] reading remote engine adapters failed; withdrawing them",
        error instanceof Error ? error.name : typeof error,
      );
    }
    if (this.sessionsByCliDeviceId.get(cliDeviceId) !== session) return false;
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    try {
      session.socket.send(
        encodeRelayServerControlMessage({
          type: "engine.adapters.set",
          id: `adapters-${randomBytes(8).toString("hex")}`,
          adapters,
        }),
      );
      return intended;
    } catch (error) {
      console.error(
        "[relay] sending remote engine adapters failed",
        error instanceof Error ? error.name : typeof error,
      );
      return false;
    }
  }

  /** The dashboard or MCP changed a device's remote engine adapters. */
  async onRemoteEngineAdaptersChanged(cliDeviceId: string) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session?.registered) return false;
    return await this.sendRemoteEngineAdapters(session);
  }

  private async writeTelemetry(
    cliDeviceId: string,
    data:
      | { nodeInfo: Omit<NodeInfoMessage, "type">; nodeInfoAt: Date }
      | { nodeMetrics: Omit<NodeMetricsMessage, "type">; nodeMetricsAt: Date },
    condition: Prisma.CliDeviceWhereInput = {},
  ) {
    try {
      await prisma.cliDevice.updateMany({ where: { ...condition, id: cliDeviceId }, data });
    } catch (error) {
      console.error(
        "[relay] storing node telemetry failed",
        error instanceof Error ? error.name : typeof error,
      );
    }
  }

  /** 30-minute engine-load history; survives reconnect of the same process. */
  getLiveEngineLoadHistory(
    keys: readonly {
      cliDeviceId: string;
      endpointSlug: string;
      modelSlug: string | null;
    }[],
    now: Date = new Date(),
  ) {
    return this.engineLoadHistory.snapshot(keys, now);
  }

  /** The freshest node metrics and endpoint load per connected CLI. */
  getLiveNodeTelemetry(cliDeviceIds: readonly string[]): Map<string, LiveNodeTelemetrySnapshot> {
    const snapshots = new Map<string, LiveNodeTelemetrySnapshot>();
    for (const cliDeviceId of cliDeviceIds) {
      const session = this.sessionsByCliDeviceId.get(cliDeviceId);
      if (!session?.registered) continue;
      snapshots.set(cliDeviceId, {
        nodeMetrics: session.nodeMetrics?.sample ?? null,
        nodeMetricsReceivedAt: session.nodeMetrics?.receivedAt ?? null,
        endpointLoad: [...session.endpointLoad.values()].map(
          ({ receivedAtMs: _receivedAtMs, ...load }) => load,
        ),
      });
    }
    return snapshots;
  }

  getLiveCliFeatures(cliDeviceIds: readonly string[]): Map<string, LiveCliFeatureSnapshot> {
    const snapshots = new Map<string, LiveCliFeatureSnapshot>();
    for (const cliDeviceId of cliDeviceIds) {
      const session = this.sessionsByCliDeviceId.get(cliDeviceId);
      if (!session?.registered || !session.protocolVersion) continue;
      snapshots.set(cliDeviceId, {
        protocolVersion: session.protocolVersion,
        cliVersion: session.cliVersion,
        humanTerminal: session.features?.humanTerminal ?? false,
        mcpCommandMode: session.features?.mcpCommandMode ?? "off",
        supervisedCommands: true,
        terminalSupported: session.features?.terminalSupported ?? false,
        terminalApproval: session.features?.terminalApproval ?? false,
        fileOps: true,
        countContext: true,
        mcpFileRead: session.features?.mcpFileRead ?? false,
        fileRootsConfigured: session.features?.fileRootsConfigured ?? false,
        allowFileToolsAsRoot: session.features?.allowFileToolsAsRoot ?? false,
        terminalPublicKey: session.terminalPublicKey,
        terminalIdentity: session.terminalIdentity,
      });
    }
    return snapshots;
  }

  terminalCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
    let user = 0;
    let cli = 0;
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        // Supervised terminals have their own limits (see cli-commands.ts);
        // operator terminals are bounded per session (OPERATOR_STEPS_PER_SESSION).
        if (terminal.phase === "pending" || terminal.origin !== "user") continue;
        if (terminal.userId === userId) user += 1;
        if (terminal.cliDeviceId === cliDeviceId) cli += 1;
      }
    }
    return { user, cli };
  }

  hasTerminal(terminalId: string): boolean {
    for (const session of this.sessionsByCliDeviceId.values()) {
      if (session.terminalsById.has(terminalId)) return true;
    }
    return false;
  }

  /**
   * `connId` names the asking browser socket, so each entry can say whether
   * that tab is attached (or waiting) and whether it is the writer.
   */
  listTerminalsForUser(
    userId: string,
    connId?: string,
  ): Array<{
    terminalId: string;
    cliDeviceId: string;
    /** Kept for one release: viewerCount > 0. */
    viewerAttached: boolean;
    viewerCount: number;
    attachedHere: boolean;
    writerHere: boolean;
    origin: TerminalOrigin;
    /** Present for agent terminals. Server-asserted request details. */
    supervised?: SupervisedTerminalListing;
    /** Present for deployment operator terminals: which step it runs (no command text). */
    deployment?: DeploymentTerminalInfo;
  }> {
    const terminals: ReturnType<RelaySessionManager["listTerminalsForUser"]> = [];
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.userId !== userId) continue;
        // A supervised or operator terminal is listed once the CLI spawned
        // it: before that there is nothing to attach to.
        if (terminal.origin !== "user" && terminal.phase !== "open") continue;
        const writer = terminalWriterViewerId(terminal);
        const writerConn = writer ? terminal.viewers.get(writer)?.connId : undefined;
        terminals.push({
          terminalId: terminal.terminalId,
          cliDeviceId: terminal.cliDeviceId,
          viewerAttached: terminal.viewers.size > 0,
          viewerCount: terminal.viewers.size,
          attachedHere: connId !== undefined && connViewerIds(terminal, connId).length > 0,
          writerHere: connId !== undefined && writerConn === connId,
          origin: terminal.origin,
          ...(terminal.supervised ? { supervised: terminal.supervised.listing() } : {}),
          ...(terminal.deployment ? { deployment: { ...terminal.deployment } } : {}),
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
   * Open a terminal on a session that already passed eligibility. `connId` is
   * the opening browser socket. The opener's viewer id is minted here unless
   * the caller already minted one. Returns false without sending when the CLI
   * cannot accept term.open.
   */
  startTerminal(input: {
    terminalId: string;
    userId: string;
    cliDeviceId: string;
    cols: number;
    rows: number;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
    connId: string;
    viewerId?: string;
  }): boolean {
    const session = this.sessionsByCliDeviceId.get(input.cliDeviceId);
    if (!session || !this.canStartTerminal(session)) return false;
    if (this.hasTerminal(input.terminalId)) return false;
    const approvalRequired = session.features?.terminalApproval === true;
    const counts = this.terminalCounts(input.userId, input.cliDeviceId);
    if (
      !approvalRequired &&
      (counts.user >= TERMINAL_USER_LIMIT || counts.cli >= TERMINAL_CLI_LIMIT)
    ) {
      return false;
    }
    const now = Date.now();
    const viewerId = input.viewerId ?? mintViewerId();
    const multiViewer = session.terminalViewers;
    const terminal: TerminalRecord = {
      terminalId: input.terminalId,
      userId: input.userId,
      cliDeviceId: input.cliDeviceId,
      cols: input.cols,
      rows: input.rows,
      multiViewer,
      viewers: new Map(),
      pendingViewers: new Map(),
      writerViewerId: null,
      phase: approvalRequired ? "pending" : "opening",
      createdAt: now,
      origin: "user",
      supervised: null,
    };
    if (multiViewer) {
      // 2.5: the opener joins the viewer set on term.opened.
      terminal.pendingViewers.set(viewerId, { connId: input.connId, requestedAt: now });
    } else {
      terminal.viewers.set(viewerId, { connId: input.connId, attachedAt: now });
    }
    session.terminalsById.set(terminal.terminalId, terminal);
    this.sendControl(session, {
      type: "term.open",
      terminalId: input.terminalId,
      ...(multiViewer ? { viewerId } : {}),
      cols: input.cols,
      rows: input.rows,
      browserPublicKey: input.browserPublicKey,
      browserNonce: input.browserNonce,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    return true;
  }

  /**
   * Attach a browser socket to a running terminal. Each attachment gets a new
   * server-minted viewer id. On 2.5 viewers coexist (up to the viewer cap). On
   * 2.4 the new viewer replaces the current one.
   */
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
    const { session, terminal } = located;
    const allowed =
      terminal.origin === "agent"
        ? this.canRunSupervised(session)
        : terminal.origin === "deployment"
          ? this.canAttachDeploymentTerminal(session)
          : this.canStartTerminal(session);
    if (!allowed) return { ok: false, error: "offline" };
    const now = Date.now();
    if (!terminal.multiViewer) {
      const viewerId = mintViewerId(terminal);
      if (session.features?.terminalApproval === true) {
        // Keep the current viewer until the CLI accepts term.auth.
        terminal.pendingViewers.clear();
        terminal.pendingViewers.set(viewerId, { connId: input.connId, requestedAt: now });
      } else {
        this.replaceLegacyViewer(terminal, viewerId, input.connId);
      }
      this.sendControl(session, {
        type: "term.attach",
        terminalId: terminal.terminalId,
        browserPublicKey: input.browserPublicKey,
        browserNonce: input.browserNonce,
        ...(input.identity ? { identity: input.identity } : {}),
      });
      return { ok: true, viewerId };
    }
    // 2.5 viewers join a spawned terminal. The opener joins through term.opened.
    if (terminal.phase !== "open") return { ok: false, error: "not_found" };
    // A second attach from the same tab replaces that tab's earlier attachment.
    const previous = connViewerIds(terminal, input.connId);
    const occupied = terminal.viewers.size + terminal.pendingViewers.size - previous.length;
    if (occupied >= TERMINAL_VIEWER_LIMIT) return { ok: false, error: "limit" };
    for (const viewerId of previous) this.removeViewer(session, terminal, viewerId);
    const viewerId = mintViewerId(terminal);
    terminal.pendingViewers.set(viewerId, { connId: input.connId, requestedAt: now });
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

  /**
   * Stop this browser socket's viewing of one terminal (X button, or a slow
   * browser). The terminal keeps running for everyone else.
   */
  detachTerminalViewer(terminalId: string, userId: string, connId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return false;
    const viewerIds = connViewerIds(located.terminal, connId);
    if (viewerIds.length === 0) return false;
    for (const viewerId of viewerIds)
      this.removeViewer(located.session, located.terminal, viewerId);
    return true;
  }

  /**
   * "End session": the owner ends the terminal for everyone, whatever runs
   * in it. On an agent terminal this is an explicit kill, also of a command
   * that just started; declining is `declineTerminalFromBrowser`.
   */
  closeTerminalFromBrowser(terminalId: string, userId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return false;
    this.closeTerminal(located.session, located.terminal, true, "user");
    return true;
  }

  /**
   * "Decline" on an agent request. Never kills anything: a request still
   * waiting for Enter is a stop request to the CLI, which declines it unless
   * an Enter came first; a command whose Enter came first keeps running.
   * The declining socket stays attached (if it was) and hears the outcome:
   * the exit (declined) or a `decline` event saying the command started.
   */
  declineTerminalFromBrowser(
    terminalId: string,
    userId: string,
    connId: string,
  ): "requested" | "started" | "not_found" | "invalid" | "offline" {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return "not_found";
    const { terminal } = located;
    if (!terminal.supervised) return "invalid";
    const answer = terminal.supervised.requestDecline();
    if (answer === "requested") {
      terminal.decliners ??= new Set();
      terminal.decliners.add(connId);
      return "requested";
    }
    if (answer === "started") return "started";
    if (answer === "unavailable") return "offline";
    return "not_found";
  }

  /** On 2.5 the server stamps the viewer id of this socket's pending attachment. */
  forwardTerminalAuth(
    terminalId: string,
    userId: string,
    connId: string,
    signature: string,
  ): "sent" | "not_found" | "offline" {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return "not_found";
    const { session, terminal } = located;
    let viewerId: string | null = null;
    if (terminal.multiViewer) {
      viewerId = pendingViewerIdForConn(terminal, connId);
      if (!viewerId) return "not_found";
    }
    if (!this.canSignalTerminal(session, terminal)) return "offline";
    this.sendControl(session, {
      type: "term.auth",
      terminalId,
      ...(viewerId ? { viewerId } : {}),
      signature,
    });
    return "sent";
  }

  /**
   * Browser input. Only an attached viewer may send it. On 2.5 the server
   * stamps that viewer's id; the browser never supplies it.
   */
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
    if (!this.canSignalTerminal(located.session, located.terminal)) return "missing";
    if (located.session.socket.readyState !== WS_READY_STATE_OPEN) return "missing";
    // A slow CLI must not grow this process without a bound.
    if ((located.session.socket.bufferedAmount ?? 0) > CLI_SEALED_BUFFER_LIMIT) return "dropped";
    const metadata: TerminalSealedMetadata = located.terminal.multiViewer
      ? { type: "term.sealed", terminalId, seq, viewerId }
      : { type: "term.sealed", terminalId, seq };
    located.session.socket.send(encodeRelayBinaryFrame(metadata, body));
    return "sent";
  }

  /**
   * Store a running command and send exec.start. False means no frame was sent
   * and the command was not stored.
   */
  dispatchExecStart(command: TrackedCliCommand, start: { command: string; cwd?: string }): boolean {
    const session = this.sessionsByCliDeviceId.get(command.cliDeviceId);
    if (!session || !this.canStartExec(session)) return false;
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    // Encoded first: a string the CLI could not read throws here, before
    // anything is registered or sent.
    const frame = encodeRelayServerControlMessage({
      type: "exec.start",
      commandId: command.commandId,
      command: start.command,
      ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
    });
    session.commandsById.set(command.commandId, command);
    session.socket.send(frame);
    return true;
  }

  /**
   * Register a supervised terminal and send `term.spawn`. False means no
   * frame was sent and nothing was registered. The terminal is listed once
   * the CLI answers `term.spawned`.
   */
  dispatchSupervisedSpawn(
    command: TrackedSupervisedCommand,
    spawn: {
      command: string;
      cwd?: string;
      reason?: string;
      requester: string;
      shareOutput: boolean;
      kind?: "command" | "file";
      fileOp?: FileSpawnSpec;
      bodyBytes?: number;
    },
    body?: Uint8Array,
  ): boolean {
    if (this.relayDrain) return false;
    const session = this.sessionsByCliDeviceId.get(command.cliDeviceId);
    if (!session || !this.canRunSupervised(session)) return false;
    if (spawn.kind === "file" && !this.canSignalFile(session)) return false;
    if ((command.kind ?? "command") !== (spawn.kind ?? "command")) return false;
    if (spawn.kind === "file" && command.fileOp !== spawn.fileOp?.op) return false;
    if (spawn.fileOp?.op === "write") {
      if (body === undefined || body.byteLength !== spawn.bodyBytes) return false;
    } else if (body !== undefined) return false;
    if (this.hasTerminal(command.terminalId) || session.supervisedById.has(command.commandId)) {
      return false;
    }
    // Encoded first: a string the CLI could not read throws here, before
    // anything is registered or sent.
    const frame = encodeRelayServerControlMessage({
      type: "term.spawn",
      terminalId: command.terminalId,
      commandId: command.commandId,
      command: spawn.command,
      ...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
      ...(spawn.reason !== undefined ? { reason: spawn.reason } : {}),
      requester: spawn.requester,
      shareOutput: spawn.shareOutput,
      ...(spawn.kind !== undefined ? { kind: spawn.kind } : {}),
      ...(spawn.fileOp !== undefined ? { fileOp: spawn.fileOp } : {}),
      ...(spawn.bodyBytes !== undefined ? { bodyBytes: spawn.bodyBytes } : {}),
    });
    const bodyFrame =
      body !== undefined
        ? encodeRelayBinaryFrame({ type: "file.body", opId: command.commandId }, body)
        : null;
    const terminal: TerminalRecord = {
      terminalId: command.terminalId,
      userId: command.userId,
      cliDeviceId: command.cliDeviceId,
      cols: 80,
      rows: 24,
      multiViewer: true,
      viewers: new Map(),
      pendingViewers: new Map(),
      writerViewerId: null,
      phase: "opening",
      createdAt: Date.now(),
      origin: "agent",
      supervised: command,
    };
    session.terminalsById.set(terminal.terminalId, terminal);
    session.supervisedById.set(command.commandId, command);
    try {
      session.socket.send(frame);
      if (bodyFrame !== null) session.socket.send(bodyFrame);
    } catch {
      // A partial send may have spawned a waiting child; it must be ended.
      // No keypress/application can come from this failed dispatch.
      try {
        this.sendControl(session, { type: "supervised.cancel", commandId: command.commandId });
      } catch {
        /* socket unavailable */
      }
      session.supervisedById.delete(command.commandId);
      session.terminalsById.delete(terminal.terminalId);
      return false;
    }
    return true;
  }

  /**
   * End a supervised command's terminal from the server side (confirm or
   * review deadline, token revoked or narrowed, review submitted). The CLI
   * kills whatever runs and drops the session; viewers see the exit.
   */
  cancelSupervised(
    cliDeviceId: string,
    commandId: string,
    cause: SupervisedTerminalGoneCause = "closed",
  ) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    const supervised = session?.supervisedById.get(commandId);
    if (!session || !supervised) return;
    const terminal = session.terminalsById.get(supervised.terminalId);
    session.supervisedById.delete(commandId);
    if (session.socket.readyState === WS_READY_STATE_OPEN) {
      this.sendControl(session, { type: "supervised.cancel", commandId });
      this.awaitSupervisedEnd(session, supervised);
    }
    // The record settles first, so the exit carries its final status.
    supervised.onTerminalGone(cause);
    if (terminal) {
      session.terminalsById.delete(terminal.terminalId);
      terminalBridge?.onTerminalEvent({
        type: "exit",
        terminalId: terminal.terminalId,
        connIds: terminalConnIds(terminal),
        ...supervisedExitFields(supervised),
      });
    }
    this.notifyTerminalListChanged(supervised.userId);
  }

  /**
   * Ask the CLI to stop a supervised request that still waits for Enter
   * (confirm deadline or browser decline). Nothing is torn down here: the
   * CLI answers with `supervised.declined` + `term.exit`, or with the
   * `supervised.accepted` it already sent if the Enter came first.
   */
  requestSupervisedStop(
    cliDeviceId: string,
    commandId: string,
    reason: "expire" | "decline",
  ): boolean {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session?.supervisedById.has(commandId)) return false;
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    this.sendControl(session, { type: "supervised.cancel", commandId, reason });
    return true;
  }

  /** Keep listening for the CLI's last word on a terminal the server ended. */
  private awaitSupervisedEnd(session: SessionState, supervised: TrackedSupervisedCommand) {
    session.endingSupervised.delete(supervised.terminalId);
    session.endingSupervised.set(supervised.terminalId, supervised);
    // Bounded: the CLI answers every close with `term.exit`; a CLI that does
    // not only loses the "had it started" detail for its oldest entries.
    while (session.endingSupervised.size > ENDING_SUPERVISED_MAX) {
      const oldest = session.endingSupervised.keys().next().value;
      if (oldest === undefined) break;
      session.endingSupervised.delete(oldest);
    }
  }

  forgetCommand(cliDeviceId: string, commandId: string) {
    this.sessionsByCliDeviceId.get(cliDeviceId)?.commandsById.delete(commandId);
  }

  dispatchExecCancel(cliDeviceId: string, commandId: string) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    const command = session?.commandsById.get(commandId);
    if (!session || !command || command.status !== "running") return;
    this.cancelTrackedCommand(session, command);
  }

  /**
   * Store a file op and send `file.op` (then `file.body` for a write). False
   * means no frame was sent and the op was not stored: offline, draining, or
   * the effective mode no longer allows it (`fileOpModeRefusal` says which).
   * The frame is encoded first, so a string the CLI could not read throws
   * before anything is registered or sent.
   */
  dispatchFileOp(op: TrackedFileOp, frame: FileOpFrame, body?: Uint8Array): boolean {
    if (this.relayDrain) return false;
    const session = this.sessionsByCliDeviceId.get(op.cliDeviceId);
    if (!session || !this.canStartFile(session, isMutatingFileOp(op.op) ? "write" : "read")) {
      return false;
    }
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

  /** Ask the CLI to stop a file op. The op stays until the CLI answers or its deadline. */
  dispatchFileCancel(cliDeviceId: string, opId: string) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session?.filesById.has(opId)) return;
    if (this.canSignalFile(session)) this.sendControl(session, { type: "file.cancel", opId });
  }

  forgetFileOp(cliDeviceId: string, opId: string) {
    this.sessionsByCliDeviceId.get(cliDeviceId)?.filesById.delete(opId);
  }

  /**
   * Why a file op that passed admission was refused at the dispatch gate by
   * the mode (the grant or the CLI's own mode changed meanwhile). Null when the
   * mode still allows it.
   */
  fileOpModeRefusal(
    cliDeviceId: string,
    opClass: FileOpClass,
  ): "grant_disabled" | "feature_disabled" | "supervised_only" | null {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return null;
    const readGrant = {
      server: session.mcpFileRead === true,
      live: session.features?.mcpFileRead === true && session.features.fileOps === true,
      roots: session.features?.fileRootsConfigured === true,
    };
    return (
      fileGrantStageRefusal(session.mcpCommandMode, opClass, readGrant) ??
      fileLiveStageRefusal(
        session.mcpCommandMode,
        session.features?.mcpCommandMode ?? "off",
        opClass,
        readGrant,
      )
    );
  }

  sendRelayRequest({
    cliDeviceId,
    endpointSlug,
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
    cliDeviceId: string;
    endpointSlug: string;
    requestId: string;
    family:
      | "chat.completions"
      | "embeddings"
      | "responses"
      | "messages"
      | "audio"
      | "images"
      | "generic";
    method: string;
    path: string;
    headers: Headers | Record<string, string>;
    bodyChunks?: Uint8Array[];
    bodySource?: { size: number; open(): AsyncIterable<Uint8Array> };
    timeoutMs: number;
    countFirst?: boolean;
    countCeiling?: number;
  }) {
    if (this.relayDrain) throw new Error("CLI session is disconnected.");
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) throw new Error("CLI session is disconnected.");
    if (session.socket.readyState !== WS_READY_STATE_OPEN) {
      throw new Error("CLI session is disconnected.");
    }

    const control: RelayServerControlMessage = {
      type: "relay.request",
      requestId,
      family,
      method,
      path,
      headers: sanitizeRelayRequestHeaders(headers),
      timeoutMs,
      endpointSlug,
      expectBody: (bodySource?.size ?? 0) > 0 || bodyChunks.length > 0,
      ...(countFirst
        ? {
            countFirst: true as const,
            ...(countCeiling != null ? { countCeiling } : {}),
          }
        : {}),
    };
    session.socket.send(encodeRelayServerControlMessage(control));

    if (!bodySource && bodyChunks.length === 0) return;

    const totalBytes =
      bodySource?.size ?? bodyChunks.reduce((total, chunk) => total + chunk.byteLength, 0);

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

  supportsCountContext(cliDeviceId: string): boolean {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    return session?.registered === true;
  }

  private grantBodyCredits(session: SessionState, requestId: string, credits: number) {
    const stream = session.bodyStreamsByRequest.get(requestId);
    if (!stream) return;
    // Clamp the credit balance to the flow-control window. A single ack is already
    // bounded to `RELAY_REQUEST_BODY_WINDOW_CHUNKS`, but a misbehaving CLI could
    // spam acks to accumulate an unbounded balance and force the server to pump
    // the entire buffered body into the socket at once. Capping the balance keeps
    // outstanding (sent-unacked) chunks at or below the window: the balance never
    // exceeds the window, so `pumpBodyStream` can never emit more than the window
    // ahead of the CLI's acknowledgements.
    stream.credits = Math.min(stream.credits + credits, RELAY_REQUEST_BODY_WINDOW_CHUNKS);
    void this.pumpBodyStream(session, requestId);
  }

  // Emit request-body chunks while the CLI has granted credits and the socket
  // can accept them. Each in-flight chunk consumes one credit; the CLI returns
  // credits via `relay.request.body.ack` as its upstream request consumes them.
  private async pumpBodyStream(session: SessionState, requestId: string) {
    const stream = session.bodyStreamsByRequest.get(requestId);
    if (!stream || stream.pumping) return;
    stream.pumping = true;
    try {
      while (stream.credits > 0 && session.socket.readyState === WS_READY_STATE_OPEN) {
        let chunk = stream.chunks?.shift();
        if (!chunk) {
          const next = await stream.iterator?.next();
          // `next()` may be backed by disk I/O (or another delayed source). The
          // request can be cancelled/completed, or the session can be replaced,
          // while it is pending. Never emit the late chunk into either the old
          // socket or a new stream that reused the same request ID.
          if (
            session.bodyStreamsByRequest.get(requestId) !== stream ||
            this.sessionsByCliDeviceId.get(session.cliDeviceId ?? "") !== session
          ) {
            await closeBodyStream(stream);
            return;
          }
          if (!next || next.done) {
            session.bodyStreamsByRequest.delete(requestId);
            await closeBodyStream(stream);
            if (stream.bytesSent !== stream.totalBytes) {
              const active = this.activeRelayRequests.get(requestId);
              active?.onError({
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
        const metadata: RelayBinaryFrameMetadata = {
          type: "relay.request.body",
          requestId,
          chunkId: `${stream.nextChunkIndex}`,
          final: stream.bytesSent + chunk.byteLength === stream.totalBytes,
        };
        session.socket.send(encodeRelayBinaryFrame(metadata, chunk));
        stream.bytesSent += chunk.byteLength;
        this.activeRelayRequests.get(requestId)?.onRequestBodySent?.(chunk.byteLength);
        stream.nextChunkIndex += 1;
        stream.credits -= 1;
      }
    } catch {
      session.bodyStreamsByRequest.delete(requestId);
      await closeBodyStream(stream);
      const active = this.activeRelayRequests.get(requestId);
      active?.onError({
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
    cliDeviceId,
    requestId,
    handlers,
  }: {
    cliDeviceId: string;
    requestId: string;
    handlers: ActiveRelayResponseHandlers;
  }) {
    if (this.activeRelayRequests.has(requestId)) {
      throw new Error("Relay request ID is already active.");
    }
    this.activeRelayRequests.set(requestId, { cliDeviceId, ...handlers });
  }

  completeRelayRequest(requestId: string) {
    const active = this.takeActiveRelayRequest(requestId);
    const cliDeviceIds = new Set<string>();
    if (active) cliDeviceIds.add(active.cliDeviceId);
    for (const session of this.sessionsBySocket.values()) {
      const stream = session.bodyStreamsByRequest.get(requestId);
      if (!stream) continue;
      session.bodyStreamsByRequest.delete(requestId);
      void closeBodyStream(stream);
      if (session.cliDeviceId) cliDeviceIds.add(session.cliDeviceId);
    }
    for (const cliDeviceId of cliDeviceIds) this.considerDrainClose(cliDeviceId);
  }

  cancelRelayRequest({
    cliDeviceId,
    requestId,
    reason,
  }: {
    cliDeviceId: string;
    requestId: string;
    reason: RelayFailure;
  }) {
    this.takeActiveRelayRequest(requestId);
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return;
    const stream = session.bodyStreamsByRequest.get(requestId);
    session.bodyStreamsByRequest.delete(requestId);
    void closeBodyStream(stream);
    this.considerDrainClose(cliDeviceId);
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return;
    session.socket.send(
      encodeRelayServerControlMessage({ type: "relay.cancel", requestId, reason }),
    );
  }

  getActiveCliDeviceIds(): string[] {
    return [...this.sessionsByCliDeviceId.keys()];
  }

  private replaceDuplicateSession(newSession: SessionState) {
    if (!newSession.cliDeviceId) return;
    const existing = this.sessionsByCliDeviceId.get(newSession.cliDeviceId);
    if (existing && existing !== newSession) {
      // The new session is taking over. Tear the old socket down here — once it
      // leaves sessionsBySocket, removeSessionWithStatus returns without failing
      // its terminals, commands, or relay requests, and must not mark the device
      // DISCONNECTED.
      // R-12-1: every viewer attached through the old connection is released
      // (its terminal ends: `exit` to each attached, pending, or declining
      // browser socket), and the owners' other tabs get a fresh list, since
      // the device's terminals and live features changed without them asking.
      const owners = new Set<string>([newSession.identity.userId]);
      for (const terminal of existing.terminalsById.values()) owners.add(terminal.userId);
      this.clearDeploymentSnapshot(existing);
      existing.deploymentInventoryGeneration = null;
      this.teardownInteractiveWork(existing);
      // A replaced session must publish no more verdicts: its pending run
      // would start later than the successor's fence and win with an older reading.
      if (existing.routingEvaluation) this.routingEvaluator.cancel(existing.routingEvaluation);
      this.failActiveRequestsForSession(existing);
      this.failSttSessions(existing);
      existing.socket.close(1000, "replaced");
      this.sessionsBySocket.delete(existing.socket);
      clearTimeout(existing.unauthenticatedTimer);
      this.sessionsByCliDeviceId.set(newSession.cliDeviceId, newSession);
      for (const userId of owners) this.notifyTerminalListChanged(userId);
      return;
    }
    this.sessionsByCliDeviceId.set(newSession.cliDeviceId, newSession);
  }

  /**
   * A live speech-to-text session (design §3). Routing, admission and the
   * client protocol (chunk 6) sit on top: the caller attaches the session to a
   * candidate member with `attach`, and may try the next one when that fails.
   */
  createSttSession(input: {
    consumer: SttSessionConsumer;
    config?: SttConfig;
    maxSessionMs?: number;
  }): SttCreateResult {
    if (this.relayDrain) return { ok: false, reason: "shutting_down" };
    return this.stt.createSession(input);
  }

  private resolveSttLink(cliDeviceId: string, endpointSlug: string) {
    if (this.relayDrain) return { ok: false as const, reason: "draining" as const };
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (
      !session?.registered ||
      !session.cliDeviceId ||
      session.socket.readyState !== WS_READY_STATE_OPEN
    ) {
      return { ok: false as const, reason: "offline" as const };
    }
    if (!session.inventorySlugs.has(endpointSlug)) {
      return { ok: false as const, reason: "endpoint_unavailable" as const };
    }
    return { ok: true as const, link: this.sttLinkFor(session) };
  }

  /** One link per registered CLI session; a successor session is a new link. */
  private sttLinkFor(session: SessionState): SttRelayLink {
    let link = this.sttLinks.get(session);
    if (link) return link;
    const socket = session.socket;
    link = {
      cliDeviceId: session.cliDeviceId ?? "",
      isOpen: () =>
        socket.readyState === WS_READY_STATE_OPEN && this.sessionsBySocket.get(socket) === session,
      bufferedAmount: () => socket.bufferedAmount ?? 0,
      send: (data) => {
        if (socket.readyState !== WS_READY_STATE_OPEN) {
          throw new Error("CLI session is disconnected.");
        }
        socket.send(data);
      },
    };
    this.sttLinks.set(session, link);
    return link;
  }

  /** The CLI connection is gone or replaced: its live sessions fail. */
  private failSttSessions(session: SessionState) {
    const link = this.sttLinks.get(session);
    if (link) this.stt.linkLost(link);
  }

  private requireSession(socket: RelaySocket): SessionState {
    const session = this.sessionsBySocket.get(socket);
    if (!session) throw new Error("Unknown relay socket.");
    return session;
  }

  private failActiveRequestsForSession(session: SessionState) {
    for (const stream of session.bodyStreamsByRequest.values()) void closeBodyStream(stream);
    session.bodyStreamsByRequest.clear();
    if (!session.cliDeviceId) return;
    for (const [requestId, activeRequest] of this.activeRelayRequests) {
      if (activeRequest.cliDeviceId !== session.cliDeviceId) continue;
      this.activeRelayRequests.delete(requestId);
      activeRequest.onError({
        type: "relay.error",
        requestId,
        failure: "disconnected",
        message: "CLI session disconnected.",
      });
    }
  }

  private canStartTerminal(session: SessionState): boolean {
    return (
      session.allowHumanTerminal &&
      session.features?.humanTerminal === true &&
      session.features.terminalSupported === true &&
      session.terminalPublicKey !== null &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  /**
   * Whether the CLI can hear terminal frames. A human terminal needs the
   * CLI's browser-terminal switch; a supervised one only a 2.6 relay.
   * Without a terminal, whether any terminal frame may be sent at all.
   */
  private canSignalTerminal(session: SessionState, terminal?: TerminalRecord): boolean {
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    if (terminal?.origin === "agent" || terminal?.origin === "deployment") return true;
    if (terminal === undefined) return true;
    return session.features?.humanTerminal === true;
  }

  /** The lower of the dashboard grant and the CLI's own mode. */
  private effectiveCommandMode(session: SessionState): McpCommandModeName {
    return lowestMcpCommandMode(session.mcpCommandMode, session.features?.mcpCommandMode);
  }

  /**
   * Why a command start that passed its checks was then refused at the
   * dispatch gate by the command mode: the dashboard grant or the CLI's own
   * mode changed meanwhile. Null when the mode still allows it (the refusal
   * was something else: offline, draining, ...).
   */
  commandModeRefusal(
    cliDeviceId: string,
    kind: "headless" | "supervised",
  ): "grant_disabled" | "feature_disabled" | "supervised_only" | null {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return null;
    const allows = kind === "headless" ? allowsHeadlessCommands : allowsSupervisedCommands;
    const grant = session.mcpCommandMode;
    if (!allows(grant)) return grant === "off" ? "grant_disabled" : "supervised_only";
    const reported = session.features?.mcpCommandMode ?? "off";
    if (!allows(reported)) return reported === "off" ? "feature_disabled" : "supervised_only";
    return null;
  }

  /** Supervised terminals: MCP command mode, not the human terminal grant. */
  private supervisedPolicyAllows(session: SessionState): boolean {
    return (
      allowsSupervisedCommands(this.effectiveCommandMode(session)) &&
      session.features?.terminalSupported === true &&
      session.terminalPublicKey !== null
    );
  }

  private canRunSupervised(session: SessionState): boolean {
    return (
      this.supervisedPolicyAllows(session) && session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  /** Operator terminals: the deployment operator policy, not the human or MCP grants. */
  private canAttachDeploymentTerminal(session: SessionState): boolean {
    return (
      this.deploymentTerminalPolicyAllows(session) &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canStartExec(session: SessionState): boolean {
    return (
      allowsHeadlessCommands(this.effectiveCommandMode(session)) &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  /** Node file ops (2.8) follow the effective mode through the one file matrix. */
  private canStartFile(session: SessionState, opClass: FileOpClass): boolean {
    return (
      session.cliDeviceId !== null &&
      this.fileOpModeRefusal(session.cliDeviceId, opClass) === null &&
      session.features?.fileOps === true &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canSignalFile(session: SessionState): boolean {
    return session.socket.readyState === WS_READY_STATE_OPEN;
  }

  private canSignalExec(session: SessionState): boolean {
    return session.socket.readyState === WS_READY_STATE_OPEN;
  }

  private sendControl(session: SessionState, message: RelayServerControlMessage) {
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return;
    session.socket.send(encodeRelayServerControlMessage(message));
  }

  private reconcileInteractiveGrants(session: SessionState) {
    const terminalOk =
      session.allowHumanTerminal &&
      session.features?.humanTerminal === true &&
      session.features.terminalSupported === true;
    if (!terminalOk) {
      this.closeAllTerminals(session, this.canSignalTerminal(session), "policy", "user");
    }
    // Supervised terminals follow the MCP command mode, not the human grant.
    if (!this.supervisedPolicyAllows(session)) {
      this.closeAllTerminals(session, this.canSignalTerminal(session), "policy", "agent");
    }
    const execOk = allowsHeadlessCommands(this.effectiveCommandMode(session));
    if (!execOk) this.cancelAllCommands(session);
    this.cancelFileOpsNoLongerAllowed(session);
    // Operator terminals follow the deployment operator policy (dashboard grant included):
    // waiting ones close; a person's command already running is left to finish, like the
    // CLI's own switch (its attach is refused meanwhile).
    if (!this.deploymentTerminalPolicyAllows(session))
      for (const tracker of [...session.operatorSteps.values()])
        if (!tracker.cancelled && tracker.phase !== "running")
          this.cancelOperatorStep(session, tracker);
  }

  private teardownInteractiveWork(session: SessionState) {
    this.endOperatorSteps(session);
    this.closeAllTerminals(session, this.canSignalTerminal(session), "disconnected");
    this.cancelAllCommands(session);
    this.cancelAllFileOps(session);
  }

  /** Session loss: every in-flight file op ends `offline` (a mutating one with an unknown outcome). */
  private cancelAllFileOps(session: SessionState) {
    for (const op of [...session.filesById.values()]) {
      if (this.canSignalFile(session)) {
        this.sendControl(session, { type: "file.cancel", opId: op.opId });
      }
      op.markLost("offline");
    }
  }

  /**
   * The grant or the CLI's own mode dropped: file ops the matrix no longer
   * allows are cancelled and end with the refusal the mode now gives.
   */
  private cancelFileOpsNoLongerAllowed(session: SessionState) {
    for (const op of [...session.filesById.values()]) {
      const opClass: FileOpClass = isMutatingFileOp(op.op) ? "write" : "read";
      const refusal = this.fileOpModeRefusal(op.cliDeviceId, opClass);
      if (refusal === null) continue;
      if (this.canSignalFile(session)) {
        this.sendControl(session, { type: "file.cancel", opId: op.opId });
      }
      op.markLost(refusal);
    }
  }

  private closeAllTerminals(
    session: SessionState,
    signalCli: boolean,
    cause: SupervisedTerminalGoneCause,
    origin?: TerminalRecord["origin"],
  ) {
    for (const terminal of [...session.terminalsById.values()]) {
      if (origin !== undefined && terminal.origin !== origin) continue;
      this.closeTerminal(session, terminal, signalCli, cause);
    }
  }

  /**
   * Forget a terminal, tell its viewers it exited, and optionally tell the
   * CLI to close it (`term.close` also ends a supervised terminal). A
   * supervised terminal's command record hears why.
   */
  private closeTerminal(
    session: SessionState,
    terminal: TerminalRecord,
    signalCli: boolean,
    cause: SupervisedTerminalGoneCause = "closed",
  ) {
    session.terminalsById.delete(terminal.terminalId);
    if (signalCli && session.socket.readyState === WS_READY_STATE_OPEN) {
      this.sendControl(session, { type: "term.close", terminalId: terminal.terminalId });
    }
    const supervised = terminal.supervised;
    if (supervised) {
      if (session.supervisedById.get(supervised.commandId) === supervised) {
        session.supervisedById.delete(supervised.commandId);
      }
      if (signalCli && session.socket.readyState === WS_READY_STATE_OPEN) {
        this.awaitSupervisedEnd(session, supervised);
      }
      // The record settles first, so the exit carries its final status.
      supervised.onTerminalGone(cause);
    }
    terminalBridge?.onTerminalEvent({
      type: "exit",
      terminalId: terminal.terminalId,
      connIds: terminalConnIds(terminal),
      ...(supervised ? supervisedExitFields(supervised) : {}),
    });
    if (supervised || terminal.origin === "deployment")
      this.notifyTerminalListChanged(terminal.userId);
  }

  /** 2.4: the new viewer takes the terminal and every other tab hears `detached`. */
  private replaceLegacyViewer(terminal: TerminalRecord, viewerId: string, connId: string) {
    const previous = [...terminal.viewers.values()];
    terminal.viewers.clear();
    terminal.viewers.set(viewerId, { connId, attachedAt: Date.now() });
    for (const viewer of previous) {
      if (viewer.connId === connId) continue;
      terminalBridge?.onTerminalEvent({
        type: "detached",
        terminalId: terminal.terminalId,
        connId: viewer.connId,
      });
    }
  }

  /**
   * Drop one attachment (attached or pending) and tell the CLI. On 2.5 the
   * remaining viewers hear the new count.
   */
  private removeViewer(session: SessionState, terminal: TerminalRecord, viewerId: string): boolean {
    const wasViewer = terminal.viewers.delete(viewerId);
    const wasPending = terminal.pendingViewers.delete(viewerId);
    if (!wasViewer && !wasPending) return false;
    const writerLeft = terminal.writerViewerId === viewerId;
    if (writerLeft) terminal.writerViewerId = null;
    if (this.canSignalTerminal(session, terminal)) {
      if (terminal.multiViewer) {
        this.sendControl(session, {
          type: "term.detach",
          terminalId: terminal.terminalId,
          viewerId,
        });
      } else if (wasViewer) {
        // 2.4 keeps its behavior: a waiting replacement leaves without a signal.
        this.sendControl(session, { type: "term.detach", terminalId: terminal.terminalId });
      }
    }
    if (wasViewer || writerLeft) this.emitViewers(terminal);
    return true;
  }

  /** 2.5: tell every attached viewer the count and who is typing. */
  private emitViewers(terminal: TerminalRecord) {
    if (!terminal.multiViewer || terminal.viewers.size === 0) return;
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

  private cancelAllCommands(session: SessionState) {
    for (const command of [...session.commandsById.values()]) {
      if (command.status !== "running") continue;
      if (this.canSignalExec(session)) {
        this.sendControl(session, { type: "exec.cancel", commandId: command.commandId });
      }
      // The CLI may already be gone. Free the slot now instead of waiting
      // out the 11-minute command deadline.
      command.markCancelled();
    }
  }

  private cancelTrackedCommand(session: SessionState, command: TrackedCliCommand) {
    if (command.status !== "running") return;
    // Cancellation asks the CLI to stop. The slot stays until exec.done,
    // exec.rejected, or the server deadline in the command registry.
    if (this.canSignalExec(session)) {
      this.sendControl(session, { type: "exec.cancel", commandId: command.commandId });
    }
  }

  /**
   * Drop approval handshakes that never spawned, and 2.5 attachments that the
   * CLI never answered. Pending terminals do not count toward the terminal cap.
   */
  sweepExpiredPendingTerminals(now = Date.now()) {
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of [...session.terminalsById.values()]) {
        if (terminal.phase === "pending") {
          if (now - terminal.createdAt < TERMINAL_PENDING_TTL_MS) continue;
          session.terminalsById.delete(terminal.terminalId);
          // The CLI may have spawned the shell just before the deadline; a
          // close for a terminal it never opened is a no-op there.
          if (this.canSignalTerminal(session)) {
            this.sendControl(session, { type: "term.close", terminalId: terminal.terminalId });
          }
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
        if (!terminal.multiViewer || terminal.phase !== "open") continue;
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
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.userId !== userId) continue;
        terminal.decliners?.delete(connId);
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
    for (const session of this.sessionsByCliDeviceId.values()) {
      const terminal = session.terminalsById.get(terminalId);
      if (!terminal) continue;
      if (terminal.userId !== userId) return null;
      return { session, terminal };
    }
    return null;
  }

  /**
   * CLI output. 2.4 frames go to the one viewer. On 2.5 a frame names either
   * one viewer (unicast) or an output-key epoch (broadcast to every attached
   * viewer). Frames for an unknown viewer, or with neither, are dropped.
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
    if (!terminal.multiViewer) {
      if (metadata.viewerId !== undefined || metadata.epoch !== undefined) return;
      const connIds = [...terminal.viewers.values()].map((viewer) => viewer.connId);
      if (connIds.length > 0) terminalBridge?.onTerminalEvent({ ...base, connIds });
      return;
    }
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
    message: Extract<
      RelayClientControlMessage,
      {
        type:
          | "term.pending"
          | "term.opened"
          | "term.attached"
          | "term.rejected"
          | "term.writer"
          | "term.input_dropped"
          | "term.exit";
      }
    >,
  ) {
    const terminal = session.terminalsById.get(message.terminalId);
    if (!terminal) {
      if (message.type === "term.exit") {
        // The CLI's last word on a supervised terminal the server ended.
        const ending = session.endingSupervised.get(message.terminalId);
        if (ending) {
          session.endingSupervised.delete(message.terminalId);
          ending.onLateReport("settled");
        }
        return;
      }
      // A late open/attach/pending for a terminal we no longer track (for
      // example one whose handshake expired) would otherwise leave a shell
      // with no server-side owner. Ask the CLI to close it; the CLI treats a
      // close for an unknown terminal as a no-op, so this cannot loop.
      if (
        (message.type === "term.opened" ||
          message.type === "term.attached" ||
          message.type === "term.pending") &&
        this.canSignalTerminal(session)
      ) {
        this.sendControl(session, { type: "term.close", terminalId: message.terminalId });
      }
      return;
    }
    if (message.type === "term.input_dropped") {
      // Only a notice: viewers, the writer and the phase stay as they are.
      const viewer = terminal.multiViewer
        ? message.viewerId
          ? terminal.viewers.get(message.viewerId)
          : undefined
        : firstEntry(terminal.viewers)?.[1];
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
      const supervised = terminal.supervised;
      if (supervised) {
        if (session.supervisedById.get(supervised.commandId) === supervised) {
          session.supervisedById.delete(supervised.commandId);
        }
        // The record settles first, so the exit carries its final status.
        supervised.onTerminalGone("exit");
      }
      terminalBridge?.onTerminalEvent({
        type: "exit",
        terminalId: terminal.terminalId,
        connIds: terminalConnIds(terminal),
        ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
        ...(message.signal !== undefined ? { signal: message.signal } : {}),
        ...(supervised ? { supervisedStatus: supervised.listing().status } : {}),
      });
      if (supervised || terminal.origin === "deployment")
        this.notifyTerminalListChanged(terminal.userId);
      return;
    }
    // A supervised terminal is spawned with `term.spawn` and an operator
    // terminal with its deployment job, never opened by a browser; before
    // `term.spawned` / `awaiting_operator` nothing on it can be attached.
    if (
      terminal.origin !== "user" &&
      (message.type === "term.opened" || terminal.phase !== "open")
    ) {
      return;
    }
    if (terminal.multiViewer) {
      this.handleMultiViewerControl(session, terminal, message);
      return;
    }
    if (message.type === "term.writer") return;
    this.handleLegacyTerminalControl(session, terminal, message);
  }

  /** 2.4: one viewer, and a replacement waits in `pendingViewers` for approval. */
  private handleLegacyTerminalControl(
    session: SessionState,
    terminal: TerminalRecord,
    message: Extract<
      RelayClientControlMessage,
      { type: "term.pending" | "term.opened" | "term.attached" | "term.rejected" }
    >,
  ) {
    if (message.type === "term.pending") {
      const cliPublicKey = session.terminalPublicKey;
      if (!cliPublicKey) return;
      const target = firstEntry(terminal.pendingViewers) ?? firstEntry(terminal.viewers);
      if (!target) return;
      terminalBridge?.onTerminalEvent({
        type: "pending",
        terminalId: terminal.terminalId,
        connId: target[1].connId,
        viewerId: target[0],
        cliPublicKey,
        cliNonce: message.cliNonce,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
    if (message.type === "term.opened" || message.type === "term.attached") {
      const replacement = firstEntry(terminal.pendingViewers);
      if (replacement) {
        terminal.pendingViewers.delete(replacement[0]);
        this.replaceLegacyViewer(terminal, replacement[0], replacement[1].connId);
      }
      terminal.phase = "open";
      if (message.type === "term.opened" && this.terminalOverLimit(terminal)) {
        this.closeTerminal(session, terminal, true);
        return;
      }
      const cliPublicKey = session.terminalPublicKey;
      if (!cliPublicKey) {
        this.closeTerminal(session, terminal, true);
        return;
      }
      const current = firstEntry(terminal.viewers);
      if (!current) return;
      terminalBridge?.onTerminalEvent({
        type: message.type === "term.opened" ? "opened" : "attached",
        terminalId: terminal.terminalId,
        connId: current[1].connId,
        viewerId: current[0],
        cliPublicKey,
        cliNonce: message.cliNonce,
      });
      return;
    }
    const replacement = firstEntry(terminal.pendingViewers);
    if (replacement && terminal.phase === "open") {
      terminal.pendingViewers.delete(replacement[0]);
      terminalBridge?.onTerminalEvent({
        type: "rejected",
        terminalId: terminal.terminalId,
        connId: replacement[1].connId,
        reason: message.reason,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
    const current = firstEntry(terminal.viewers);
    terminal.viewers.clear();
    if (terminal.phase === "opening" || terminal.phase === "pending") {
      session.terminalsById.delete(terminal.terminalId);
    }
    if (!current) return;
    terminalBridge?.onTerminalEvent({
      type: "rejected",
      terminalId: terminal.terminalId,
      connId: current[1].connId,
      reason: message.reason,
      ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
    });
  }

  /** 2.5: every message names the viewer it concerns. Unknown viewer ids are dropped. */
  private handleMultiViewerControl(
    session: SessionState,
    terminal: TerminalRecord,
    message: Extract<
      RelayClientControlMessage,
      { type: "term.pending" | "term.opened" | "term.attached" | "term.rejected" | "term.writer" }
    >,
  ) {
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
      const cliPublicKey = session.terminalPublicKey;
      const pending = terminal.pendingViewers.get(viewerId);
      if (!cliPublicKey || !pending) return;
      terminalBridge?.onTerminalEvent({
        type: "pending",
        terminalId: terminal.terminalId,
        connId: pending.connId,
        viewerId,
        cliPublicKey,
        cliNonce: message.cliNonce,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
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
      const cliPublicKey = session.terminalPublicKey;
      if (!cliPublicKey) {
        this.closeTerminal(session, terminal, true);
        return;
      }
      const pending = terminal.pendingViewers.get(viewerId);
      // The tab may have left while the CLI was spawning or approving.
      if (!pending) return;
      terminal.pendingViewers.delete(viewerId);
      terminal.viewers.set(viewerId, { connId: pending.connId, attachedAt: Date.now() });
      // The opener is the first writer. The CLI confirms with term.writer.
      if (message.type === "term.opened" && terminal.writerViewerId === null) {
        terminal.writerViewerId = viewerId;
      }
      terminalBridge?.onTerminalEvent({
        type: message.type === "term.opened" ? "opened" : "attached",
        terminalId: terminal.terminalId,
        connId: pending.connId,
        viewerId,
        cliPublicKey,
        cliNonce: message.cliNonce,
      });
      this.emitViewers(terminal);
      return;
    }
    const target = terminal.pendingViewers.get(viewerId) ?? terminal.viewers.get(viewerId);
    const wasViewer = terminal.viewers.delete(viewerId);
    terminal.pendingViewers.delete(viewerId);
    if (terminal.writerViewerId === viewerId) terminal.writerViewerId = null;
    if (terminal.phase !== "open") {
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
    const counts = this.terminalCounts(terminal.userId, terminal.cliDeviceId);
    return counts.user > TERMINAL_USER_LIMIT || counts.cli > TERMINAL_CLI_LIMIT;
  }

  private handleExecControl(
    session: SessionState,
    message: Extract<
      RelayClientControlMessage,
      { type: "exec.started" | "exec.rejected" | "exec.done" }
    >,
  ) {
    const command = session.commandsById.get(message.commandId);
    if (!command) return;
    if (message.type === "exec.started") {
      command.markStarted();
      return;
    }
    if (message.type === "exec.rejected") {
      command.markRejected(message.reason);
      return;
    }
    command.markDone({
      ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
      ...(message.signal !== undefined ? { signal: message.signal } : {}),
      timedOut: message.timedOut,
    });
  }

  /**
   * `file.result` / `file.rejected`. Only the op the server dispatched to this
   * very session is touched; a frame naming another op id is dropped.
   */
  private handleFileControl(
    session: SessionState,
    message: Extract<RelayClientControlMessage, { type: "file.result" | "file.rejected" }>,
  ) {
    const tracked = session.filesById.get(message.opId);
    if (!tracked) return;
    if (message.type === "file.result") {
      tracked.markResult(message);
      return;
    }
    tracked.markRejected(message.reason, message.detail);
  }

  /**
   * CLI reports for a supervised command. Only the command the server
   * dispatched to this very session is touched; a frame naming another
   * command id is dropped.
   */
  private handleSupervisedControl(
    session: SessionState,
    message: Extract<
      RelayClientControlMessage,
      {
        type:
          | "term.spawned"
          | "supervised.rejected"
          | "supervised.accepted"
          | "supervised.declined"
          | "supervised.done";
      }
    >,
  ) {
    const supervised = session.supervisedById.get(message.commandId);
    if (!supervised) {
      // A spawn the server no longer tracks (cancelled meanwhile): end it.
      if (message.type === "term.spawned" && this.canSignalTerminal(session)) {
        this.sendControl(session, { type: "term.close", terminalId: message.terminalId });
      }
      const ending = [...session.endingSupervised.values()].find(
        (candidate) => candidate.commandId === message.commandId,
      );
      if (ending && message.type === "supervised.accepted") {
        ending.onLateReport("accepted");
      } else if (
        ending &&
        (message.type === "supervised.declined" || message.type === "supervised.rejected")
      ) {
        session.endingSupervised.delete(ending.terminalId);
        ending.onLateReport("settled");
      }
      return;
    }
    const terminal = session.terminalsById.get(supervised.terminalId);
    if (message.type === "supervised.done") {
      const fileDone = message.fileResult !== undefined || message.fileError !== undefined;
      if (
        fileDone !== (supervised.kind === "file") ||
        (message.fileResult &&
          (message.fileResult.op !== supervised.fileOp ||
            supervised.listing().status === "awaiting_user"))
      ) {
        this.isolateMalformedInteractiveFrame(session, JSON.stringify(message));
        return;
      }
    }
    if (message.type === "term.spawned") {
      if (message.terminalId !== supervised.terminalId || !terminal) return;
      if (terminal.phase === "open") return;
      terminal.phase = "open";
      supervised.onSpawned();
      this.notifyTerminalListChanged(supervised.userId);
      return;
    }
    if (message.type === "supervised.rejected") {
      if (
        supervised.kind === "file" &&
        !supervisedFileRejectReasonSchema.safeParse(message.reason).success
      ) {
        this.isolateMalformedInteractiveFrame(session, JSON.stringify(message));
        return;
      }
      // Nothing was spawned, so no term.exit follows.
      session.supervisedById.delete(supervised.commandId);
      supervised.onRejected(message.reason);
      if (terminal) {
        session.terminalsById.delete(terminal.terminalId);
        terminalBridge?.onTerminalEvent({
          type: "exit",
          terminalId: terminal.terminalId,
          connIds: terminalConnIds(terminal),
          supervisedStatus: supervised.listing().status,
        });
      }
      this.notifyTerminalListChanged(supervised.userId);
      return;
    }
    if (message.type === "supervised.accepted") {
      const wasWaiting = supervised.listing().status === "awaiting_user";
      supervised.onAccepted();
      // A Decline still out lost to this Enter: tell those tabs it started
      // (once: a repeated `accepted` changes nothing).
      const decliners = terminal?.decliners;
      if (
        terminal &&
        decliners &&
        decliners.size > 0 &&
        wasWaiting &&
        supervised.listing().status === "running"
      ) {
        terminalBridge?.onTerminalEvent({
          type: "decline",
          terminalId: terminal.terminalId,
          connIds: [...decliners],
          outcome: "started",
        });
      }
    } else if (message.type === "supervised.declined") {
      supervised.onDeclined();
    } else {
      supervised.onDone({
        ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
        ...(message.signal !== undefined ? { signal: message.signal } : {}),
        review: message.review,
        ...(message.outputBytes !== undefined ? { outputBytes: message.outputBytes } : {}),
        ...(message.fileResult !== undefined ? { fileResult: message.fileResult } : {}),
        ...(message.fileError !== undefined ? { fileError: message.fileError } : {}),
      });
    }
    this.notifyTerminalListChanged(supervised.userId);
  }

  /**
   * A term.* / exec.* frame that fails schema validation closes that terminal
   * or command only. Other malformed frames return false so the relay socket
   * still takes the protocol-error path.
   */
  private isolateMalformedInteractiveFrame(session: SessionState, frame: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object") return false;
    const record = parsed as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") return false;
    if (type.startsWith("term.")) {
      const terminalId = typeof record.terminalId === "string" ? record.terminalId : null;
      let terminal = terminalId ? session.terminalsById.get(terminalId) : undefined;
      if (!terminal && typeof record.commandId === "string") {
        const supervised = session.supervisedById.get(record.commandId);
        terminal = supervised ? session.terminalsById.get(supervised.terminalId) : undefined;
      }
      if (terminal) {
        this.closeTerminal(session, terminal, this.canSignalTerminal(session, terminal), "closed");
      }
      console.error("[relay] malformed terminal frame");
      return true;
    }
    if (type.startsWith("supervised.")) {
      const commandId = typeof record.commandId === "string" ? record.commandId : null;
      const supervised = commandId ? session.supervisedById.get(commandId) : undefined;
      const terminal = supervised ? session.terminalsById.get(supervised.terminalId) : undefined;
      if (terminal)
        this.closeTerminal(session, terminal, this.canSignalTerminal(session), "closed");
      console.error("[relay] malformed supervised-command frame");
      return true;
    }
    if (type.startsWith("exec.")) {
      const commandId = typeof record.commandId === "string" ? record.commandId : null;
      const command = commandId ? session.commandsById.get(commandId) : undefined;
      if (command?.status === "running") this.cancelTrackedCommand(session, command);
      console.error("[relay] malformed exec frame");
      return true;
    }
    if (type.startsWith("file.") && session.registered) {
      // A file answer outside the strict schema fails that op only (never the
      // session); an unknown op id is dropped. Nothing of the frame is logged.
      const opId = typeof record.opId === "string" ? record.opId : null;
      const tracked = opId ? session.filesById.get(opId) : undefined;
      if (tracked) {
        this.sendControl(session, { type: "file.cancel", opId: tracked.opId });
        tracked.markMalformed();
      }
      console.error("[relay] malformed file frame");
      return true;
    }
    if (type.startsWith("stt.") && session.registered) {
      // A live speech-to-text answer outside the strict schema fails the one
      // session it names (its events or credits would be lost otherwise); an
      // unknown session id is dropped. Nothing of the frame is logged (it may
      // carry transcript text), and at most once a minute per CLI, since a
      // broken CLI could send one per delta.
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
    // Telemetry is advisory: a reading outside the strict schema (or an
    // unknown field) drops that frame, never the session and the inference
    // it carries. Nothing from the frame is stored or logged but its type.
    if (session.registered && TELEMETRY_FRAME_TYPES.has(type)) {
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
      if (relay) {
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
    return false;
  }

  private async probeOwnedPoolMember(member: OwnedRecoveryMember): Promise<boolean | "superseded"> {
    const surface = suggestedConnectionSurface({
      capabilities: member.capabilities as OpenAiCompatibleCapabilities | null,
    });
    if (!surface) return false;
    const request =
      surface === "OPENAI_RESPONSES"
        ? {
            family: "responses" as const,
            path: "/v1/responses",
            body: {
              model: member.upstreamModelId,
              input: "Reply with pong.",
              max_output_tokens: 8,
            },
          }
        : surface === "ANTHROPIC_MESSAGES"
          ? {
              family: "messages" as const,
              path: "/v1/messages",
              body: {
                model: member.upstreamModelId,
                max_tokens: 8,
                messages: [{ role: "user", content: "Reply with pong." }],
              },
            }
          : {
              family: "chat.completions" as const,
              path: "/v1/chat/completions",
              body: {
                model: member.upstreamModelId,
                stream: false,
                max_tokens: 8,
                messages: [{ role: "user", content: "Reply with pong." }],
              },
            };
    const headers = new Headers({ "content-type": "application/json" });
    if (surface === "ANTHROPIC_MESSAGES") headers.set("anthropic-version", "2023-06-01");
    // The probe is only evidence about the connection it was dispatched on. If
    // that session is replaced (a reconnect took over the device id) or lost
    // while it runs, its `disconnected` failure belongs to the old connection,
    // not the member, and must not be recorded against the successor.
    const dispatchedOn = this.sessionsByCliDeviceId.get(member.cliDeviceId);
    // Nothing to probe through (the owner detached after the scheduler's check):
    // a probe that could not be sent proves nothing about the member.
    if (!dispatchedOn) return "superseded";
    const superseded = () => this.sessionsByCliDeviceId.get(member.cliDeviceId) !== dispatchedOn;
    const attempt = startRelayAttempt({
      manager: this,
      cliDeviceId: member.cliDeviceId,
      endpointSlug: member.endpointSlug,
      family: request.family,
      method: "POST",
      path: request.path,
      headers,
      body: new TextEncoder().encode(JSON.stringify(request.body)),
      timeoutMs: POOL_MEMBER_RECOVERY_PROBE_TIMEOUT_MS,
    });
    try {
      const started = await attempt.started;
      // Drain the bounded probe reply so a relay can complete normally. Probe
      // semantics are transport health, not a provider-specific text contract.
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
