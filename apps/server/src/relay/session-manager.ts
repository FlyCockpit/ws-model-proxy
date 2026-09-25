import { randomBytes } from "node:crypto";
import type { LiveCliFeatureSnapshot } from "@ws-model-proxy/api/context";
import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  lowestMcpCommandMode,
  type McpCommandModeName,
  mcpCommandModeFromDb,
  mcpCommandModeToDb,
} from "@ws-model-proxy/api/lib/mcp-command-mode";
import { suggestedConnectionSurface } from "@ws-model-proxy/api/lib/model-connection-type";
import {
  markPoolMembersForCliUnavailable,
  type PoolMemberFailureClass,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import type { SupervisedCommandStatus } from "@ws-model-proxy/api/lib/supervised-command-types";
import prisma from "@ws-model-proxy/db";
import { startRelayAttempt } from "../model-api/relay-executor.js";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  listDueOwnedPoolMemberRecoveries,
  type OwnedRecoveryMember,
  POOL_MEMBER_RECOVERY_PROBE_TIMEOUT_MS,
  PoolMemberRecoveryScheduler,
} from "./pool-member-recovery.js";
import {
  type CliTerminalIdentity,
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  helloNeedsUpgrade,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_STALE_AFTER_MS,
  RELAY_UNREGISTERED_STALE_AFTER_MS,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
  type RelayBinaryFrameMetadata,
  type RelayClientControlMessage,
  type RelayFailure,
  type RelayProtocolVersion,
  type RelayResponseBodyMetadata,
  type RelayServerControlMessage,
  relayProtocolAtLeast,
  type TerminalHandshakeIdentity,
  type TerminalSealedMetadata,
} from "./protocol.js";
import {
  persistRelayRegistration,
  RelayRegistrationError,
  type ReportedRelayFeatures,
} from "./registration.js";

const WS_READY_STATE_OPEN = 1;

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
  humanTerminal: boolean;
  /** The CLI's own MCP command mode (its config), from hello. */
  mcpCommandMode: McpCommandModeName;
  terminalApproval: boolean;
  terminalSupported: boolean;
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
   */
  origin: "user" | "agent";
  /** Set iff `origin` is `agent`. */
  supervised: TrackedSupervisedCommand | null;
  /**
   * Agent terminals: browser sockets that sent Decline. They hear whether an
   * Enter beat it (`decline` event, once, on the waiting -> running step) and
   * the terminal's exit, even when they do not view the terminal. Kept until
   * the terminal ends (the set goes with it) or the socket closes (its entry
   * is removed); bounded by the owner's sockets.
   */
  decliners?: Set<string>;
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
export const TERMINAL_CLI_LIMIT = 2;
/** 2.5: attached viewers plus pending approvals per terminal. */
export const TERMINAL_VIEWER_LIMIT = 8;
const CLI_SEALED_BUFFER_LIMIT = 1024 * 1024;
const TERMINAL_PENDING_TTL_MS = 2 * 60 * 1000;
/** Ended supervised terminals whose CLI `term.exit` is still awaited, per session. */
const ENDING_SUPERVISED_MAX = 16;
const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;

type SessionState = {
  socket: RelaySocket;
  identity: CliWebsocketIdentity;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  cliDeviceId: string | null;
  cli: { slug: string } | null;
  registered: boolean;
  inventoryConfirmed: boolean;
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
  /** Server grant for MCP commands (dashboard). The CLI's own mode is in `features`. */
  mcpCommandMode: McpCommandModeName;
  terminalsById: Map<string, TerminalRecord>;
  commandsById: Map<string, TrackedCliCommand>;
  /** Supervised commands by command id, from `term.spawn` until their terminal ends. */
  supervisedById: Map<string, TrackedSupervisedCommand>;
  /**
   * Supervised commands whose terminal the server ended, by terminal id,
   * until the CLI's own `term.exit` for it: a `supervised.accepted` still in
   * flight then records that the command had started.
   */
  endingSupervised: Map<string, TrackedSupervisedCommand>;
  unauthenticatedTimer: ReturnType<typeof setTimeout>;
  bodyStreamsByRequest: Map<string, OutboundBodyStream>;
};

export type ActiveRelayResponseHandlers = {
  /** Called only after request-body bytes have been accepted by the relay socket. */
  onRequestBodySent?(byteLength: number): void;
  onHeaders(message: Extract<RelayClientControlMessage, { type: "relay.response.headers" }>): void;
  onBody(chunk: Uint8Array, metadata: RelayResponseBodyMetadata): void;
  onComplete(message: Extract<RelayClientControlMessage, { type: "relay.complete" }>): void;
  onError(message: Extract<RelayClientControlMessage, { type: "relay.error" }>): void;
  onCancelled(message: Extract<RelayClientControlMessage, { type: "relay.cancelled" }>): void;
};

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
    features: capabilities.features,
    terminalPublicKey: capabilities.terminalPublicKey,
    terminalViewers: capabilities.terminalViewers === true,
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
    reportedTerminalApproval: features.terminalApproval,
    reportedTerminalSupported: features.terminalSupported,
    reportedHostname: message.cli.hostname ?? null,
    featuresReportedAt: now,
  };
}

function interactiveTargetFromBinary(
  frame: ArrayBuffer,
): { kind: "terminal" | "command" | "supervised"; id: string } | null {
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
    return null;
  } catch {
    return null;
  }
}

function closeWithProtocolError(socket: RelaySocket, message: string) {
  if (socket.readyState === WS_READY_STATE_OPEN) {
    socket.send(
      encodeRelayServerControlMessage({
        type: "protocol.error",
        failure: "protocol_error",
        message,
      }),
    );
  }
  socket.close(1002, "protocol_error");
}

export class RelaySessionManager {
  private sessionsBySocket = new Map<RelaySocket, SessionState>();
  private sessionsByCliDeviceId = new Map<string, SessionState>();
  private activeRelayRequests = new Map<string, ActiveRelayRequest>();
  /** True once shutdown has started refusing new relay work and closing idle sockets. */
  private relayDrain = false;
  private readonly poolMemberRecovery = new PoolMemberRecoveryScheduler({
    getOwnedCliDeviceIds: () => this.getActiveCliDeviceIds(),
    listDueMembers: listDueOwnedPoolMemberRecoveries,
    probe: (member) => this.probeOwnedPoolMember(member),
  });

  acceptAuthenticatedSocket({
    socket,
    identity,
    now = new Date(),
  }: {
    socket: RelaySocket;
    identity: CliWebsocketIdentity;
    now?: Date;
  }) {
    const unauthenticatedTimer = setTimeout(() => {
      const session = this.sessionsBySocket.get(socket);
      if (!session?.registered) {
        closeWithProtocolError(socket, "Registration was not received in time.");
        this.removeSession(socket, new Date());
      }
    }, RELAY_UNREGISTERED_STALE_AFTER_MS);

    this.sessionsBySocket.set(socket, {
      socket,
      identity,
      connectedAt: now,
      lastHeartbeatAt: now,
      cliDeviceId: null,
      cli: null,
      registered: false,
      inventoryConfirmed: false,
      endpointTargeting: false,
      protocolVersion: null,
      cliVersion: null,
      features: null,
      terminalPublicKey: null,
      terminalViewers: false,
      terminalIdentity: null,
      allowHumanTerminal: false,
      mcpCommandMode: "off",
      terminalsById: new Map(),
      commandsById: new Map(),
      supervisedById: new Map(),
      endingSupervised: new Map(),
      unauthenticatedTimer,
      bodyStreamsByRequest: new Map(),
    });
  }

  async handleTextFrame(socket: RelaySocket, frame: string, now = new Date()) {
    const session = this.requireSession(socket);
    // An older CLI gets a message it prints ("upgrade wsmp"), not an opaque
    // schema rejection. Every released CLI treats protocol.error as fatal.
    if (!session.registered && helloNeedsUpgrade(frame)) {
      console.error("[relay] refused a hello older than the minimum relay protocol");
      closeWithProtocolError(socket, RELAY_UPGRADE_REQUIRED_MESSAGE);
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
      closeWithProtocolError(socket, "Malformed relay protocol message.");
      await this.removeSession(socket, now);
      return;
    }

    if (message.type === "hello") {
      try {
        const registration = await persistRelayRegistration({
          identity: session.identity,
          cli: message.cli,
          endpoints: message.endpoints,
          inventoryConfirmed: true,
          endpointTargeting: true,
          connection: true,
          reported: reportedFeaturesFromHello(message, now),
          now,
        });
        if (this.sessionsBySocket.get(socket) !== session) {
          // Detached while registration ran (socket closed, or its credential
          // revoked / device deleted). The registration committed CONNECTED
          // for a session that no longer exists: do not route to it, and put
          // the device status back unless another live session owns it.
          await this.settleDetachedRegistration(registration.cliDeviceId, now);
          return;
        }
        session.cliDeviceId = registration.cliDeviceId;
        session.cli = { slug: message.cli.slug };
        session.registered = true;
        session.inventoryConfirmed = true;
        session.endpointTargeting = true;
        session.protocolVersion = message.protocolVersion;
        session.cliVersion = message.cli.version ?? null;
        session.allowHumanTerminal = registration.allowHumanTerminal;
        session.mcpCommandMode = registration.mcpCommandMode;
        const interactive = interactiveCapabilities(message.cli.capabilities);
        session.features = interactive.features;
        session.terminalPublicKey = interactive.terminalPublicKey;
        session.terminalViewers = interactive.terminalViewers;
        session.terminalIdentity = interactive.terminalIdentity;
        session.lastHeartbeatAt = now;
        clearTimeout(session.unauthenticatedTimer);
        this.reconcileInteractiveGrants(session);
        this.replaceDuplicateSession(session);
        this.poolMemberRecovery.wake();
        socket.send(
          encodeRelayServerControlMessage({
            type: "hello.ok",
            id: message.id,
            protocolVersion: message.protocolVersion,
            revision: registration.revision,
            desiredCapabilities: registration.desiredCapabilities,
          }),
        );
      } catch (error) {
        // Already detached and closed by whoever detached it.
        if (this.sessionsBySocket.get(socket) !== session) return;
        const relayError =
          error instanceof RelayRegistrationError && error.code === "access_denied"
            ? "access_denied"
            : "protocol_error";
        socket.send(
          encodeRelayServerControlMessage({
            type: "protocol.error",
            failure: "protocol_error",
            message: relayError,
            requestId: message.id,
          }),
        );
        socket.close(1008, relayError);
        await this.removeSession(socket, now);
      }
      return;
    }

    if (!session.registered || !session.cliDeviceId) {
      closeWithProtocolError(socket, "Registration is required before relay messages.");
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
            encodeRelayServerControlMessage({
              type: "protocol.error",
              failure: "protocol_error",
              message: "access_denied",
              requestId: message.id,
            }),
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

    if (message.type === "heartbeat") {
      session.lastHeartbeatAt = now;
      await prisma.cliDevice.update({
        where: { id: session.cliDeviceId },
        data: { status: "CONNECTED", lastHeartbeatAt: now },
        select: { id: true },
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

    if (message.type === "relay.request.body.ack") {
      this.grantBodyCredits(session, message.requestId, message.credits);
      return;
    }

    if (message.type === "relay.response.headers") {
      this.activeRelayRequests.get(message.requestId)?.onHeaders(message);
      return;
    }

    if (message.type === "relay.complete") {
      const activeRequest = this.takeActiveRelayRequest(message.requestId);
      if (!activeRequest) return;
      activeRequest.onComplete(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
      return;
    }

    if (message.type === "relay.error") {
      const activeRequest = this.takeActiveRelayRequest(message.requestId);
      if (!activeRequest) return;
      activeRequest.onError(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
      return;
    }

    if (message.type === "relay.cancelled") {
      const activeRequest = this.takeActiveRelayRequest(message.requestId);
      if (!activeRequest) return;
      activeRequest.onCancelled(message);
      this.considerDrainClose(activeRequest.cliDeviceId);
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
        this.activeRelayRequests
          .get(parsed.metadata.requestId)
          ?.onBody(parsed.body, parsed.metadata);
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
    this.poolMemberRecovery.stop();
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
    this.teardownInteractiveWork(session);
    clearTimeout(session.unauthenticatedTimer);
    this.sessionsBySocket.delete(socket);
    this.failActiveRequestsForSession(session);
    const cliDeviceId = session.cliDeviceId;
    if (!cliDeviceId || this.sessionsByCliDeviceId.get(cliDeviceId) !== session) return null;
    this.sessionsByCliDeviceId.delete(cliDeviceId);
    return () => this.writeDeviceDisconnected(cliDeviceId, { now, cliStatus, failureClass });
  }

  /**
   * Persists that no session serves this device. `updateMany` because the
   * device may have been deleted (its sessions are closed right after).
   */
  private async writeDeviceDisconnected(
    cliDeviceId: string,
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
    await prisma.cliDevice.updateMany({
      where: { id: cliDeviceId },
      data: { status: cliStatus, lastDisconnectedAt: now },
    });
    await markPoolMembersForCliUnavailable({ cliDeviceId, failureClass, now });
    this.poolMemberRecovery.wake();
  }

  /**
   * A hello's registration committed (device CONNECTED) after its session was
   * detached. The session never entered routing; undo the connected status
   * unless another live session now owns the device (its own registration
   * wrote CONNECTED and routing points at it).
   */
  private async settleDetachedRegistration(cliDeviceId: string, now: Date) {
    if (this.sessionsByCliDeviceId.has(cliDeviceId)) return;
    await this.writeDeviceDisconnected(cliDeviceId, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
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

  /** Refuse new relay and terminal sockets. Synchronous so shutdown can stop admission first. */
  beginDrain() {
    this.relayDrain = true;
  }

  isDraining(): boolean {
    return this.relayDrain;
  }

  /** Shutdown step: cancel interactive work, close remaining CLI sockets, mark devices disconnected. */
  async closeRelaySessions(now = new Date()) {
    this.beginDrain();
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
      session.socket.close(1001, "shutdown");
    }
    return this.detachSession(session.socket, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
    });
  }

  private sessionHasActiveRelayWork(session: SessionState): boolean {
    if (session.bodyStreamsByRequest.size > 0) return true;
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

  async onCliFeatureGrantsChanged(cliDeviceId: string) {
    const device = await prisma.cliDevice.findUnique({
      where: { id: cliDeviceId },
      select: { allowHumanTerminal: true, mcpCommandMode: true },
    });
    this.applyFeatureGrants(cliDeviceId, {
      allowHumanTerminal: device?.allowHumanTerminal === true,
      mcpCommandMode: device ? mcpCommandModeFromDb(device.mcpCommandMode) : "off",
    });
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
    await this.closeSessionsMatching((session) => session.identity.userId === userId, now);
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
          encodeRelayServerControlMessage({
            type: "protocol.error",
            failure: "protocol_error",
            message: "access_denied",
          }),
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
    grants: { allowHumanTerminal: boolean; mcpCommandMode: McpCommandModeName },
  ) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return;
    session.allowHumanTerminal = grants.allowHumanTerminal;
    session.mcpCommandMode = grants.mcpCommandMode;
    this.reconcileInteractiveGrants(session);
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
        supervisedCommands: relayProtocolAtLeast(session.protocolVersion, "2.6"),
        terminalSupported: session.features?.terminalSupported ?? false,
        terminalApproval: session.features?.terminalApproval ?? false,
        terminalPublicKey: relayProtocolAtLeast(session.protocolVersion, "2.4")
          ? session.terminalPublicKey
          : null,
        terminalIdentity: session.terminalViewers ? session.terminalIdentity : null,
      });
    }
    return snapshots;
  }

  terminalCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
    let user = 0;
    let cli = 0;
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        // Supervised terminals have their own limits (see cli-commands.ts).
        if (terminal.phase === "pending" || terminal.origin === "agent") continue;
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
    origin: "user" | "agent";
    /** Present for agent terminals. Server-asserted request details. */
    supervised?: SupervisedTerminalListing;
  }> {
    const terminals: ReturnType<RelaySessionManager["listTerminalsForUser"]> = [];
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.userId !== userId) continue;
        // A supervised terminal is listed once the CLI spawned it: before
        // that there is nothing to attach to.
        if (terminal.origin === "agent" && terminal.phase !== "open") continue;
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
      terminal.origin === "agent" ? this.canRunSupervised(session) : this.canStartTerminal(session);
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
    },
  ): boolean {
    if (this.relayDrain) return false;
    const session = this.sessionsByCliDeviceId.get(command.cliDeviceId);
    if (!session || !this.canRunSupervised(session)) return false;
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
    });
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
    session.socket.send(frame);
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
      this.teardownInteractiveWork(existing);
      this.failActiveRequestsForSession(existing);
      existing.socket.close(1000, "replaced");
      this.sessionsBySocket.delete(existing.socket);
      clearTimeout(existing.unauthenticatedTimer);
    }
    this.sessionsByCliDeviceId.set(newSession.cliDeviceId, newSession);
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
      relayProtocolAtLeast(session.protocolVersion, "2.4") &&
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
    if (!relayProtocolAtLeast(session.protocolVersion, "2.6")) return false;
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return false;
    if (terminal?.origin === "agent") return true;
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
      relayProtocolAtLeast(session.protocolVersion, "2.6") &&
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

  private canStartExec(session: SessionState): boolean {
    return (
      relayProtocolAtLeast(session.protocolVersion, "2.6") &&
      allowsHeadlessCommands(this.effectiveCommandMode(session)) &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canSignalExec(session: SessionState): boolean {
    return (
      relayProtocolAtLeast(session.protocolVersion, "2.6") &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private sendControl(session: SessionState, message: RelayServerControlMessage) {
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return;
    session.socket.send(encodeRelayServerControlMessage(message));
  }

  private reconcileInteractiveGrants(session: SessionState) {
    const terminalOk =
      relayProtocolAtLeast(session.protocolVersion, "2.6") &&
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
    const execOk =
      relayProtocolAtLeast(session.protocolVersion, "2.6") &&
      allowsHeadlessCommands(this.effectiveCommandMode(session));
    if (!execOk) this.cancelAllCommands(session);
  }

  private teardownInteractiveWork(session: SessionState) {
    this.closeAllTerminals(session, this.canSignalTerminal(session), "disconnected");
    this.cancelAllCommands(session);
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
    if (supervised) this.notifyTerminalListChanged(terminal.userId);
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
      if (supervised) this.notifyTerminalListChanged(terminal.userId);
      return;
    }
    // A supervised terminal is spawned with `term.spawn`, never opened by a
    // browser; before `term.spawned` nothing on it can be attached.
    if (
      terminal.origin === "agent" &&
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
    if (message.type === "term.spawned") {
      if (message.terminalId !== supervised.terminalId || !terminal) return;
      if (terminal.phase === "open") return;
      terminal.phase = "open";
      supervised.onSpawned();
      this.notifyTerminalListChanged(supervised.userId);
      return;
    }
    if (message.type === "supervised.rejected") {
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
    return false;
  }

  private async probeOwnedPoolMember(member: OwnedRecoveryMember): Promise<boolean> {
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
      return started.status >= 200 && started.status < 300 && terminal.ok;
    } catch {
      return false;
    }
  }
}

export const relaySessionManager = new RelaySessionManager();
