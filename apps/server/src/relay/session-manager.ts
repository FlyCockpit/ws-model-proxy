import type { CliWebsocketIdentity } from "@ws-model-proxy/api/lib/cli-credential-access";
import {
  markPoolMembersForCliUnavailable,
  type PoolMemberFailureClass,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import prisma from "@ws-model-proxy/db";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  RELAY_MAX_QUEUED_OUTBOUND_CHUNKS_PER_REQUEST,
  RELAY_STALE_AFTER_MS,
  RELAY_UNREGISTERED_STALE_AFTER_MS,
  type RelayBinaryFrameMetadata,
  type RelayClientControlMessage,
  type RelayFailure,
  type RelayServerControlMessage,
} from "./protocol.js";
import { persistRelayRegistration, RelayRegistrationError } from "./registration.js";

const WS_READY_STATE_OPEN = 1;

export type RelaySocket = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
};

type SessionState = {
  socket: RelaySocket;
  identity: CliWebsocketIdentity;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  cliDeviceId: string | null;
  cli: { slug: string; label: string } | null;
  registered: boolean;
  unauthenticatedTimer: ReturnType<typeof setTimeout>;
  queuedOutboundByRequest: Map<string, (string | ArrayBuffer)[]>;
};

export type ActiveRelayResponseHandlers = {
  onHeaders(message: Extract<RelayClientControlMessage, { type: "relay.response.headers" }>): void;
  onBody(chunk: Uint8Array, metadata: RelayBinaryFrameMetadata): void;
  onComplete(message: Extract<RelayClientControlMessage, { type: "relay.complete" }>): void;
  onError(message: Extract<RelayClientControlMessage, { type: "relay.error" }>): void;
  onCancelled(message: Extract<RelayClientControlMessage, { type: "relay.cancelled" }>): void;
};

type ActiveRelayRequest = ActiveRelayResponseHandlers & {
  cliDeviceId: string;
};

class RelayBackpressureError extends Error {
  constructor(public readonly requestId: string) {
    super("Relay request queue is full.");
    this.name = "RelayBackpressureError";
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
      unauthenticatedTimer,
      queuedOutboundByRequest: new Map(),
    });
  }

  async handleTextFrame(socket: RelaySocket, frame: string, now = new Date()) {
    const session = this.requireSession(socket);
    let message: RelayClientControlMessage;
    try {
      message = parseRelayClientControlFrame(frame);
    } catch {
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
          now,
        });
        session.cliDeviceId = registration.cliDeviceId;
        session.cli = { slug: message.cli.slug, label: message.cli.label };
        session.registered = true;
        session.lastHeartbeatAt = now;
        clearTimeout(session.unauthenticatedTimer);
        this.replaceDuplicateSession(session);
        socket.send(
          encodeRelayServerControlMessage({
            type: "hello.ok",
            id: message.id,
            protocolVersion: "1.0",
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
      await persistRelayRegistration({
        identity: session.identity,
        cli: session.cli,
        endpoints: message.endpoints,
        now,
      });
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

    if (message.type === "relay.response.headers") {
      this.activeRelayRequests.get(message.requestId)?.onHeaders(message);
      return;
    }

    if (message.type === "relay.complete") {
      const activeRequest = this.activeRelayRequests.get(message.requestId);
      if (!activeRequest) return;
      this.activeRelayRequests.delete(message.requestId);
      activeRequest.onComplete(message);
      return;
    }

    if (message.type === "relay.error") {
      const activeRequest = this.activeRelayRequests.get(message.requestId);
      if (!activeRequest) return;
      this.activeRelayRequests.delete(message.requestId);
      activeRequest.onError(message);
      return;
    }

    if (message.type === "relay.cancelled") {
      const activeRequest = this.activeRelayRequests.get(message.requestId);
      if (!activeRequest) return;
      this.activeRelayRequests.delete(message.requestId);
      activeRequest.onCancelled(message);
    }
  }

  handleBinaryFrame(socket: RelaySocket, frame: ArrayBuffer) {
    this.requireSession(socket);
    const parsed = parseRelayBinaryFrame(frame);
    if (parsed.metadata.type !== "relay.response.body") return;
    this.activeRelayRequests.get(parsed.metadata.requestId)?.onBody(parsed.body, parsed.metadata);
  }

  async removeSession(socket: RelaySocket, now = new Date()) {
    await this.removeSessionWithStatus(socket, {
      now,
      cliStatus: "DISCONNECTED",
      failureClass: "WEBSOCKET_DISCONNECTED",
    });
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
    clearTimeout(session.unauthenticatedTimer);
    this.sessionsBySocket.delete(socket);
    if (session.cliDeviceId && this.sessionsByCliDeviceId.get(session.cliDeviceId) === session) {
      this.sessionsByCliDeviceId.delete(session.cliDeviceId);
      this.failActiveRequestsForCli(session.cliDeviceId);
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
      session.socket.close(1001, "stale");
      await this.removeSessionWithStatus(session.socket, {
        now,
        cliStatus: "STALE",
        failureClass: "STALE_SESSION",
      });
    }
  }

  sendRelayRequest({
    cliDeviceId,
    requestId,
    family,
    method,
    path,
    headers,
    bodyChunks = [],
    timeoutMs,
  }: {
    cliDeviceId: string;
    requestId: string;
    family:
      | "chat.completions"
      | "completions"
      | "embeddings"
      | "responses"
      | "audio"
      | "images"
      | "generic";
    method: string;
    path: string;
    headers: Headers | Record<string, string>;
    bodyChunks?: Uint8Array[];
    timeoutMs: number;
  }) {
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) throw new Error("CLI session is disconnected.");

    const control: RelayServerControlMessage = {
      type: "relay.request",
      requestId,
      family,
      method,
      path,
      headers: sanitizeRelayRequestHeaders(headers),
      timeoutMs,
    };
    this.sendOrQueue(session, requestId, encodeRelayServerControlMessage(control));

    bodyChunks.forEach((chunk, index) => {
      const metadata: RelayBinaryFrameMetadata = {
        type: "relay.request.body",
        requestId,
        chunkId: `${index}`,
        final: index === bodyChunks.length - 1,
      };
      this.sendOrQueue(session, requestId, encodeRelayBinaryFrame(metadata, chunk));
    });
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
    this.activeRelayRequests.delete(requestId);
    this.flushQueuedOutbound(requestId);
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
    this.activeRelayRequests.delete(requestId);
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (!session) return;
    session.queuedOutboundByRequest.delete(requestId);
    this.sendOrQueue(
      session,
      requestId,
      encodeRelayServerControlMessage({ type: "relay.cancel", requestId, reason }),
    );
  }

  flushQueuedOutbound(requestId: string) {
    for (const session of this.sessionsBySocket.values()) {
      const queued = session.queuedOutboundByRequest.get(requestId);
      if (!queued) continue;
      while (queued.length > 0 && this.canSendImmediately(session.socket)) {
        const frame = queued.shift();
        if (frame) session.socket.send(frame);
      }
      if (queued.length === 0) session.queuedOutboundByRequest.delete(requestId);
    }
  }

  getActiveCliDeviceIds(): string[] {
    return [...this.sessionsByCliDeviceId.keys()];
  }

  private replaceDuplicateSession(newSession: SessionState) {
    if (!newSession.cliDeviceId) return;
    const existing = this.sessionsByCliDeviceId.get(newSession.cliDeviceId);
    if (existing && existing !== newSession) {
      existing.socket.close(1000, "replaced");
      this.sessionsBySocket.delete(existing.socket);
      clearTimeout(existing.unauthenticatedTimer);
    }
    this.sessionsByCliDeviceId.set(newSession.cliDeviceId, newSession);
  }

  private sendOrQueue(session: SessionState, requestId: string, frame: string | ArrayBuffer) {
    if (this.canSendImmediately(session.socket)) {
      session.socket.send(frame);
      return;
    }

    const queued = session.queuedOutboundByRequest.get(requestId) ?? [];
    if (queued.length >= RELAY_MAX_QUEUED_OUTBOUND_CHUNKS_PER_REQUEST) {
      throw new RelayBackpressureError(requestId);
    }
    queued.push(frame);
    session.queuedOutboundByRequest.set(requestId, queued);
  }

  private canSendImmediately(socket: RelaySocket): boolean {
    return socket.readyState === WS_READY_STATE_OPEN && (socket.bufferedAmount ?? 0) === 0;
  }

  private requireSession(socket: RelaySocket): SessionState {
    const session = this.sessionsBySocket.get(socket);
    if (!session) throw new Error("Unknown relay socket.");
    return session;
  }

  private failActiveRequestsForCli(cliDeviceId: string) {
    for (const [requestId, activeRequest] of this.activeRelayRequests) {
      if (activeRequest.cliDeviceId !== cliDeviceId) continue;
      this.activeRelayRequests.delete(requestId);
      activeRequest.onError({
        type: "relay.error",
        requestId,
        failure: "disconnected",
        message: "CLI session disconnected.",
      });
    }
  }
}

export const relaySessionManager = new RelaySessionManager();
