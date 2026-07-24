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
  RELAY_PROTOCOL_VERSION,
  RELAY_REQUEST_BODY_WINDOW_CHUNKS,
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

// Per-request outbound request-body stream. The server holds the remaining
// body chunks and only emits them while the CLI has granted credits, so a slow
// upstream on one request pauses that request's body flow (its credits stop
// returning) without blocking sibling requests on the same socket.
type OutboundBodyStream = {
  chunks: Uint8Array[];
  nextChunkIndex: number;
  totalChunks: number;
  credits: number;
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
  bodyStreamsByRequest: Map<string, OutboundBodyStream>;
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
      bodyStreamsByRequest: new Map(),
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
            protocolVersion: RELAY_PROTOCOL_VERSION,
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

    if (message.type === "relay.request.body.ack") {
      this.grantBodyCredits(session, message.requestId, message.credits);
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
      expectBody: bodyChunks.length > 0,
    };
    session.socket.send(encodeRelayServerControlMessage(control));

    if (bodyChunks.length === 0) return;

    session.bodyStreamsByRequest.set(requestId, {
      chunks: [...bodyChunks],
      nextChunkIndex: 0,
      totalChunks: bodyChunks.length,
      credits: RELAY_REQUEST_BODY_WINDOW_CHUNKS,
    });
    this.pumpBodyStream(session, requestId);
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
    this.pumpBodyStream(session, requestId);
  }

  // Emit request-body chunks while the CLI has granted credits and the socket
  // can accept them. Each in-flight chunk consumes one credit; the CLI returns
  // credits via `relay.request.body.ack` as its upstream request consumes them.
  private pumpBodyStream(session: SessionState, requestId: string) {
    const stream = session.bodyStreamsByRequest.get(requestId);
    if (!stream) return;
    while (
      stream.chunks.length > 0 &&
      stream.credits > 0 &&
      session.socket.readyState === WS_READY_STATE_OPEN
    ) {
      const chunk = stream.chunks.shift();
      if (!chunk) break;
      const metadata: RelayBinaryFrameMetadata = {
        type: "relay.request.body",
        requestId,
        chunkId: `${stream.nextChunkIndex}`,
        final: stream.nextChunkIndex === stream.totalChunks - 1,
      };
      session.socket.send(encodeRelayBinaryFrame(metadata, chunk));
      stream.nextChunkIndex += 1;
      stream.credits -= 1;
    }
    if (stream.chunks.length === 0) {
      session.bodyStreamsByRequest.delete(requestId);
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
    this.activeRelayRequests.delete(requestId);
    for (const session of this.sessionsBySocket.values()) {
      session.bodyStreamsByRequest.delete(requestId);
    }
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
    session.bodyStreamsByRequest.delete(requestId);
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
