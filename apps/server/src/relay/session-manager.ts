import type { LiveCliFeatureSnapshot } from "@ws-model-proxy/api/context";
import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import { suggestedConnectionSurface } from "@ws-model-proxy/api/lib/model-connection-type";
import {
  markPoolMembersForCliUnavailable,
  type PoolMemberFailureClass,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
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
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
  RELAY_STALE_AFTER_MS,
  RELAY_UNREGISTERED_STALE_AFTER_MS,
  type RelayBinaryFrameMetadata,
  type RelayClientControlMessage,
  type RelayFailure,
  type RelayProtocolVersion,
  type RelayResponseBodyMetadata,
  type RelayServerControlMessage,
  type TerminalHandshakeIdentity,
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
  mcpCommands: boolean;
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

export type TerminalRecord = {
  terminalId: string;
  userId: string;
  cliDeviceId: string;
  label: string;
  cols: number;
  rows: number;
  viewerId: string | null;
  /** Set while a replacement viewer is waiting for approval. The current viewer stays. */
  pendingViewerId: string | null;
  phase: "pending" | "opening" | "open";
  createdAt: number;
};

export type TerminalLifecycleEvent =
  | {
      type: "opened" | "attached" | "pending";
      terminalId: string;
      viewerId: string | null;
      cliPublicKey: string;
      cliNonce: string;
      approvalCode?: string;
    }
  | {
      type: "rejected";
      terminalId: string;
      viewerId: string | null;
      reason: string;
      approvalCode?: string;
    }
  | {
      type: "exit";
      terminalId: string;
      viewerId: string | null;
      exitCode?: number;
      signal?: string;
    }
  | { type: "detached"; terminalId: string; viewerId: string }
  | { type: "sealed"; terminalId: string; viewerId: string | null; seq: number; body: Uint8Array };

type TerminalBridge = {
  onTerminalEvent(event: TerminalLifecycleEvent): void;
};

let terminalBridge: TerminalBridge | null = null;

export function registerTerminalBridge(bridge: TerminalBridge) {
  terminalBridge = bridge;
}

const TERMINAL_USER_LIMIT = 4;
const TERMINAL_CLI_LIMIT = 2;
const CLI_SEALED_BUFFER_LIMIT = 1024 * 1024;
const TERMINAL_PENDING_TTL_MS = 2 * 60 * 1000;
const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;

type SessionState = {
  socket: RelaySocket;
  identity: CliWebsocketIdentity;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  cliDeviceId: string | null;
  cli: { slug: string; label: string } | null;
  registered: boolean;
  inventoryConfirmed: boolean;
  endpointTargeting: boolean;
  protocolVersion: RelayProtocolVersion | null;
  cliVersion: string | null;
  features: CliReportedFeatures | null;
  terminalPublicKey: string | null;
  allowHumanTerminal: boolean;
  allowMcpCommands: boolean;
  terminalsById: Map<string, TerminalRecord>;
  commandsById: Map<string, TrackedCliCommand>;
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

function reportedFeaturesFromHello(
  message: Extract<RelayClientControlMessage, { type: "hello" }>,
  now: Date,
): ReportedRelayFeatures {
  const cliVersion = message.cli.version ?? null;
  if (message.protocolVersion === "2.4" && message.cli.capabilities.protocolVersion === "2.4") {
    const features = message.cli.capabilities.features;
    return {
      cliVersion,
      relayProtocolVersion: "2.4",
      reportedHumanTerminal: features.humanTerminal,
      reportedMcpCommands: features.mcpCommands,
      reportedTerminalApproval: features.terminalApproval,
      reportedTerminalSupported: features.terminalSupported,
      featuresReportedAt: now,
    };
  }
  return {
    cliVersion,
    relayProtocolVersion: message.protocolVersion,
    reportedHumanTerminal: null,
    reportedMcpCommands: null,
    reportedTerminalApproval: null,
    reportedTerminalSupported: null,
    featuresReportedAt: null,
  };
}

function interactiveTargetFromBinary(
  frame: ArrayBuffer,
): { kind: "terminal" | "command"; id: string } | null {
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
      allowHumanTerminal: false,
      allowMcpCommands: false,
      terminalsById: new Map(),
      commandsById: new Map(),
      unauthenticatedTimer,
      bodyStreamsByRequest: new Map(),
    });
  }

  async handleTextFrame(socket: RelaySocket, frame: string, now = new Date()) {
    const session = this.requireSession(socket);
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
      if (message.protocolVersion === "2.0" && message.endpoints.length > 1) {
        closeWithProtocolError(
          socket,
          "Legacy relay clients may publish only one endpoint; upgrade wsmp for multi-endpoint routing.",
        );
        await this.removeSession(socket, now);
        return;
      }
      try {
        const registration = await persistRelayRegistration({
          identity: session.identity,
          cli: message.cli,
          endpoints: message.endpoints,
          inventoryConfirmed: message.protocolVersion !== "2.0",
          endpointTargeting: message.protocolVersion !== "2.0",
          connection: true,
          reported: reportedFeaturesFromHello(message, now),
          now,
        });
        session.cliDeviceId = registration.cliDeviceId;
        session.cli = { slug: message.cli.slug, label: message.cli.label };
        session.registered = true;
        session.inventoryConfirmed = message.protocolVersion !== "2.0";
        session.endpointTargeting = message.protocolVersion !== "2.0";
        session.protocolVersion = message.protocolVersion;
        session.cliVersion = message.cli.version ?? null;
        session.allowHumanTerminal = registration.allowHumanTerminal;
        session.allowMcpCommands = registration.allowMcpCommands;
        if (
          message.protocolVersion === "2.4" &&
          message.cli.capabilities.protocolVersion === "2.4"
        ) {
          session.features = message.cli.capabilities.features;
          session.terminalPublicKey = message.cli.capabilities.terminalPublicKey;
        } else {
          session.features = null;
          session.terminalPublicKey = null;
        }
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
        socket.send(
          encodeRelayServerControlMessage({
            type: "inventory.ok",
            id: message.id,
            revision: registration.revision,
            desiredCapabilities: registration.desiredCapabilities,
          }),
        );
      } catch (error) {
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
        this.forwardSealedToBrowser(
          session,
          parsed.metadata.terminalId,
          parsed.metadata.seq,
          parsed.body,
        );
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
    const session = this.sessionsBySocket.get(socket);
    if (!session) return;
    this.teardownInteractiveWork(session);
    clearTimeout(session.unauthenticatedTimer);
    this.sessionsBySocket.delete(socket);
    this.failActiveRequestsForSession(session);
    if (session.cliDeviceId && this.sessionsByCliDeviceId.get(session.cliDeviceId) === session) {
      this.sessionsByCliDeviceId.delete(session.cliDeviceId);
      await prisma.cliDevice.update({
        where: { id: session.cliDeviceId },
        data: { status: cliStatus, lastDisconnectedAt: now },
        select: { id: true },
      });
      await markPoolMembersForCliUnavailable({
        cliDeviceId: session.cliDeviceId,
        failureClass,
        now,
      });
      this.poolMemberRecovery.wake();
    }
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
    this.relayDrain = true;
    await this.shutdownRelaySessions(
      [...this.sessionsBySocket.values()].filter(
        (session) => !this.sessionHasActiveRelayWork(session),
      ),
      now,
    );
  }

  isDraining(): boolean {
    return this.relayDrain;
  }

  /** Shutdown step: cancel interactive work, close remaining CLI sockets, mark devices disconnected. */
  async closeRelaySessions(now = new Date()) {
    this.relayDrain = true;
    await this.shutdownRelaySessions([...this.sessionsBySocket.values()], now);
  }

  private async shutdownRelaySessions(sessions: SessionState[], now: Date) {
    let failure: unknown;
    for (const session of sessions) {
      try {
        await this.shutdownRelaySession(session, now);
      } catch (error) {
        failure = error;
        console.error(
          "[relay] closeRelaySessions failed",
          error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
        );
      }
    }
    if (failure) throw failure instanceof Error ? failure : new Error("closeRelaySessions failed");
  }

  private async shutdownRelaySession(session: SessionState, now: Date) {
    if (!this.sessionsBySocket.has(session.socket)) return;
    this.teardownInteractiveWork(session);
    if (session.socket.readyState === WS_READY_STATE_OPEN) {
      session.socket.close(1001, "shutdown");
    }
    await this.removeSessionWithStatus(session.socket, {
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
    void this.shutdownRelaySession(session, new Date()).catch((error: unknown) => {
      console.error(
        "[relay] idle session close failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
    });
  }

  async onCliFeatureGrantsChanged(cliDeviceId: string) {
    const device = await prisma.cliDevice.findUnique({
      where: { id: cliDeviceId },
      select: { allowHumanTerminal: true, allowMcpCommands: true },
    });
    this.applyFeatureGrants(cliDeviceId, {
      allowHumanTerminal: device?.allowHumanTerminal === true,
      allowMcpCommands: device?.allowMcpCommands === true,
    });
  }

  applyFeatureGrants(
    cliDeviceId: string,
    grants: { allowHumanTerminal: boolean; allowMcpCommands: boolean },
  ) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return;
    session.allowHumanTerminal = grants.allowHumanTerminal;
    session.allowMcpCommands = grants.allowMcpCommands;
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
        mcpCommands: session.features?.mcpCommands ?? false,
        terminalSupported: session.features?.terminalSupported ?? false,
        terminalApproval: session.features?.terminalApproval ?? false,
        terminalPublicKey: session.protocolVersion === "2.4" ? session.terminalPublicKey : null,
      });
    }
    return snapshots;
  }

  terminalCounts(userId: string, cliDeviceId: string): { user: number; cli: number } {
    let user = 0;
    let cli = 0;
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.phase === "pending") continue;
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

  listTerminalsForUser(userId: string): Array<{
    terminalId: string;
    cliDeviceId: string;
    label: string;
    viewerAttached: boolean;
  }> {
    const terminals: Array<{
      terminalId: string;
      cliDeviceId: string;
      label: string;
      viewerAttached: boolean;
    }> = [];
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.userId !== userId) continue;
        terminals.push({
          terminalId: terminal.terminalId,
          cliDeviceId: terminal.cliDeviceId,
          label: terminal.label,
          viewerAttached: terminal.viewerId !== null,
        });
      }
    }
    return terminals;
  }

  /**
   * Open a terminal on a 2.4 session that already passed eligibility.
   * Returns false without sending when the CLI cannot accept term.open.
   */
  startTerminal(input: {
    terminalId: string;
    userId: string;
    cliDeviceId: string;
    label: string;
    cols: number;
    rows: number;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
    viewerId: string;
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
    const terminal: TerminalRecord = {
      terminalId: input.terminalId,
      userId: input.userId,
      cliDeviceId: input.cliDeviceId,
      label: input.label,
      cols: input.cols,
      rows: input.rows,
      viewerId: input.viewerId,
      pendingViewerId: null,
      phase: approvalRequired ? "pending" : "opening",
      createdAt: Date.now(),
    };
    session.terminalsById.set(terminal.terminalId, terminal);
    this.sendControl(session, {
      type: "term.open",
      terminalId: input.terminalId,
      cols: input.cols,
      rows: input.rows,
      browserPublicKey: input.browserPublicKey,
      browserNonce: input.browserNonce,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    return true;
  }

  attachTerminal(input: {
    terminalId: string;
    userId: string;
    viewerId: string;
    browserPublicKey: string;
    browserNonce: string;
    identity?: TerminalHandshakeIdentity;
  }): { ok: true } | { ok: false; error: "not_found" | "offline" } {
    const located = this.terminalForUser(input.terminalId, input.userId);
    if (!located) return { ok: false, error: "not_found" };
    const { session, terminal } = located;
    if (!this.canStartTerminal(session)) return { ok: false, error: "offline" };
    const approvalRequired = session.features?.terminalApproval === true;
    if (approvalRequired) {
      // Keep the current viewer until the CLI accepts term.auth.
      terminal.pendingViewerId = input.viewerId;
    } else {
      if (terminal.viewerId && terminal.viewerId !== input.viewerId) {
        const previous = terminal.viewerId;
        terminal.viewerId = null;
        terminalBridge?.onTerminalEvent({
          type: "detached",
          terminalId: terminal.terminalId,
          viewerId: previous,
        });
      }
      terminal.viewerId = input.viewerId;
    }
    this.sendControl(session, {
      type: "term.attach",
      terminalId: terminal.terminalId,
      browserPublicKey: input.browserPublicKey,
      browserNonce: input.browserNonce,
      ...(input.identity ? { identity: input.identity } : {}),
    });
    return { ok: true };
  }

  detachTerminalViewer(terminalId: string, userId: string, viewerId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return false;
    if (located.terminal.viewerId !== viewerId) return false;
    located.terminal.viewerId = null;
    if (this.canSignalTerminal(located.session)) {
      this.sendControl(located.session, { type: "term.detach", terminalId });
    }
    return true;
  }

  closeTerminalFromBrowser(terminalId: string, userId: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located) return false;
    this.closeTerminal(located.session, located.terminal, true);
    return true;
  }

  forwardTerminalAuth(terminalId: string, userId: string, signature: string): boolean {
    const located = this.terminalForUser(terminalId, userId);
    if (!located || !this.canSignalTerminal(located.session)) return false;
    this.sendControl(located.session, { type: "term.auth", terminalId, signature });
    return true;
  }

  forwardBrowserSealed(
    terminalId: string,
    userId: string,
    viewerId: string,
    seq: number,
    body: Uint8Array,
  ): "sent" | "missing" | "dropped" {
    const located = this.terminalForUser(terminalId, userId);
    if (!located || located.terminal.viewerId !== viewerId) return "missing";
    if (!this.canSignalTerminal(located.session)) return "missing";
    if (located.session.socket.readyState !== WS_READY_STATE_OPEN) return "missing";
    // A slow CLI must not grow this process without a bound.
    if ((located.session.socket.bufferedAmount ?? 0) > CLI_SEALED_BUFFER_LIMIT) return "dropped";
    located.session.socket.send(
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId, seq }, body),
    );
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
    session.commandsById.set(command.commandId, command);
    this.sendControl(session, {
      type: "exec.start",
      commandId: command.commandId,
      command: start.command,
      ...(start.cwd !== undefined ? { cwd: start.cwd } : {}),
    });
    return true;
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
      session.protocolVersion === "2.4" &&
      session.allowHumanTerminal &&
      session.features?.humanTerminal === true &&
      session.features.terminalSupported === true &&
      session.terminalPublicKey !== null &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canSignalTerminal(session: SessionState): boolean {
    return (
      session.protocolVersion === "2.4" &&
      session.features?.humanTerminal === true &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canStartExec(session: SessionState): boolean {
    return (
      session.protocolVersion === "2.4" &&
      session.allowMcpCommands &&
      session.features?.mcpCommands === true &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private canSignalExec(session: SessionState): boolean {
    return (
      session.protocolVersion === "2.4" &&
      session.features?.mcpCommands === true &&
      session.socket.readyState === WS_READY_STATE_OPEN
    );
  }

  private sendControl(session: SessionState, message: RelayServerControlMessage) {
    if (session.socket.readyState !== WS_READY_STATE_OPEN) return;
    session.socket.send(encodeRelayServerControlMessage(message));
  }

  private reconcileInteractiveGrants(session: SessionState) {
    const terminalOk =
      session.protocolVersion === "2.4" &&
      session.allowHumanTerminal &&
      session.features?.humanTerminal === true &&
      session.features.terminalSupported === true;
    if (!terminalOk) {
      const signal =
        session.protocolVersion === "2.4" &&
        session.features?.humanTerminal === true &&
        session.socket.readyState === WS_READY_STATE_OPEN;
      this.closeAllTerminals(session, signal);
    }
    const execOk =
      session.protocolVersion === "2.4" &&
      session.allowMcpCommands &&
      session.features?.mcpCommands === true;
    if (!execOk) this.cancelAllCommands(session);
  }

  private teardownInteractiveWork(session: SessionState) {
    const signalTerminals =
      session.protocolVersion === "2.4" &&
      session.features?.humanTerminal === true &&
      session.socket.readyState === WS_READY_STATE_OPEN;
    this.closeAllTerminals(session, signalTerminals);
    this.cancelAllCommands(session);
  }

  private closeAllTerminals(session: SessionState, signalCli: boolean) {
    for (const terminal of [...session.terminalsById.values()]) {
      this.closeTerminal(session, terminal, signalCli);
    }
  }

  private closeTerminal(session: SessionState, terminal: TerminalRecord, signalCli: boolean) {
    session.terminalsById.delete(terminal.terminalId);
    if (signalCli && session.socket.readyState === WS_READY_STATE_OPEN) {
      this.sendControl(session, { type: "term.close", terminalId: terminal.terminalId });
    }
    terminalBridge?.onTerminalEvent({
      type: "exit",
      terminalId: terminal.terminalId,
      viewerId: terminal.viewerId,
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

  /** Drop approval handshakes that never spawned. Pending slots do not count toward the cap. */
  sweepExpiredPendingTerminals(now = Date.now()) {
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of [...session.terminalsById.values()]) {
        if (terminal.phase !== "pending") continue;
        if (now - terminal.createdAt < TERMINAL_PENDING_TTL_MS) continue;
        const viewerId = terminal.viewerId;
        session.terminalsById.delete(terminal.terminalId);
        terminalBridge?.onTerminalEvent({
          type: "rejected",
          terminalId: terminal.terminalId,
          viewerId,
          reason: "expired",
        });
      }
    }
  }

  /** Clear every viewer this socket held, including terminals still opening. */
  releaseBrowserViewer(userId: string, viewerId: string) {
    for (const session of this.sessionsByCliDeviceId.values()) {
      for (const terminal of session.terminalsById.values()) {
        if (terminal.userId !== userId) continue;
        if (terminal.pendingViewerId === viewerId) terminal.pendingViewerId = null;
        if (terminal.viewerId !== viewerId) continue;
        terminal.viewerId = null;
        if (this.canSignalTerminal(session)) {
          this.sendControl(session, { type: "term.detach", terminalId: terminal.terminalId });
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

  private forwardSealedToBrowser(
    session: SessionState,
    terminalId: string,
    seq: number,
    body: Uint8Array,
  ) {
    const terminal = session.terminalsById.get(terminalId);
    if (!terminal) return;
    terminalBridge?.onTerminalEvent({
      type: "sealed",
      terminalId,
      viewerId: terminal.viewerId,
      seq,
      body,
    });
  }

  private handleTerminalControl(
    session: SessionState,
    message: Extract<
      RelayClientControlMessage,
      { type: "term.pending" | "term.opened" | "term.attached" | "term.rejected" | "term.exit" }
    >,
  ) {
    const terminal = session.terminalsById.get(message.terminalId);
    if (!terminal) return;
    if (message.type === "term.pending") {
      const cliPublicKey = session.terminalPublicKey;
      if (!cliPublicKey) return;
      terminalBridge?.onTerminalEvent({
        type: "pending",
        terminalId: terminal.terminalId,
        viewerId: terminal.pendingViewerId ?? terminal.viewerId,
        cliPublicKey,
        cliNonce: message.cliNonce,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
    if (message.type === "term.opened" || message.type === "term.attached") {
      if (terminal.pendingViewerId && terminal.pendingViewerId !== terminal.viewerId) {
        const previous = terminal.viewerId;
        const next = terminal.pendingViewerId;
        terminal.pendingViewerId = null;
        terminal.viewerId = next;
        if (previous) {
          terminalBridge?.onTerminalEvent({
            type: "detached",
            terminalId: terminal.terminalId,
            viewerId: previous,
          });
        }
      }
      terminal.phase = "open";
      if (message.type === "term.opened") {
        const counts = this.terminalCounts(terminal.userId, terminal.cliDeviceId);
        if (counts.user > TERMINAL_USER_LIMIT || counts.cli > TERMINAL_CLI_LIMIT) {
          this.closeTerminal(session, terminal, true);
          return;
        }
      }
      const cliPublicKey = session.terminalPublicKey;
      if (!cliPublicKey) {
        this.closeTerminal(session, terminal, true);
        return;
      }
      terminalBridge?.onTerminalEvent({
        type: message.type === "term.opened" ? "opened" : "attached",
        terminalId: terminal.terminalId,
        viewerId: terminal.viewerId,
        cliPublicKey,
        cliNonce: message.cliNonce,
      });
      return;
    }
    if (message.type === "term.rejected") {
      const replacement = terminal.pendingViewerId;
      if (replacement && terminal.phase === "open") {
        terminal.pendingViewerId = null;
        terminalBridge?.onTerminalEvent({
          type: "rejected",
          terminalId: terminal.terminalId,
          viewerId: replacement,
          reason: message.reason,
          ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
        });
        return;
      }
      const viewerId = terminal.viewerId;
      const unspawned = terminal.phase === "opening" || terminal.phase === "pending";
      terminal.viewerId = null;
      if (unspawned) session.terminalsById.delete(terminal.terminalId);
      terminalBridge?.onTerminalEvent({
        type: "rejected",
        terminalId: terminal.terminalId,
        viewerId,
        reason: message.reason,
        ...(message.approvalCode ? { approvalCode: message.approvalCode } : {}),
      });
      return;
    }
    const viewerId = terminal.viewerId;
    session.terminalsById.delete(terminal.terminalId);
    terminalBridge?.onTerminalEvent({
      type: "exit",
      terminalId: terminal.terminalId,
      viewerId,
      ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
      ...(message.signal !== undefined ? { signal: message.signal } : {}),
    });
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
      const terminal = terminalId ? session.terminalsById.get(terminalId) : undefined;
      if (terminal) this.closeTerminal(session, terminal, this.canSignalTerminal(session));
      console.error("[relay] malformed terminal frame");
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
