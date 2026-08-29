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
  unauthenticatedTimer: ReturnType<typeof setTimeout>;
  bodyStreamsByRequest: Map<string, OutboundBodyStream>;
};

export type ActiveRelayResponseHandlers = {
  /** Called only after request-body bytes have been accepted by the relay socket. */
  onRequestBodySent?(byteLength: number): void;
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
          now,
        });
        session.cliDeviceId = registration.cliDeviceId;
        session.cli = { slug: message.cli.slug, label: message.cli.label };
        session.registered = true;
        session.inventoryConfirmed = message.protocolVersion !== "2.0";
        session.endpointTargeting = message.protocolVersion !== "2.0";
        session.lastHeartbeatAt = now;
        clearTimeout(session.unauthenticatedTimer);
        this.replaceDuplicateSession(session);
        this.poolMemberRecovery.wake();
        socket.send(
          encodeRelayServerControlMessage({
            type: "hello.ok",
            id: message.id,
            protocolVersion: RELAY_PROTOCOL_VERSION,
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
      | "completions"
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
    this.activeRelayRequests.delete(requestId);
    for (const session of this.sessionsBySocket.values()) {
      const stream = session.bodyStreamsByRequest.get(requestId);
      session.bodyStreamsByRequest.delete(requestId);
      void closeBodyStream(stream);
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
    const stream = session.bodyStreamsByRequest.get(requestId);
    session.bodyStreamsByRequest.delete(requestId);
    void closeBodyStream(stream);
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
    const session = this.sessionsByCliDeviceId.get(cliDeviceId);
    if (session) {
      for (const stream of session.bodyStreamsByRequest.values()) void closeBodyStream(stream);
      session.bodyStreamsByRequest.clear();
    }
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
