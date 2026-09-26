import { randomBytes, randomUUID } from "node:crypto";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { LiveCliFeatureSnapshot } from "@ws-model-proxy/api/context";
import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import {
  TERMINAL_BROWSER_JSON_LIMIT,
  TERMINAL_BROWSER_JSON_WINDOW_MS,
  TERMINAL_BROWSER_TEXT_PENDING_LIMIT,
} from "@ws-model-proxy/config/terminal-socket-policy";
import prisma from "@ws-model-proxy/db";
import { userCredentialAccessBlocked } from "@ws-model-proxy/db/user-deletion-access";
import { env } from "@ws-model-proxy/env/server";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { z } from "zod";
import { resolveClientIp } from "../client-ip.js";
import { createRateLimiterMiddleware, rpcLimiter } from "../rate-limit.js";
import { sessionMiddleware } from "../session-middleware.js";
import {
  base64Url16ByteSchema,
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  relayProtocolAtLeast,
  uncompressedP256PublicKeySchema,
} from "./protocol.js";
import {
  type RelaySocket,
  registerTerminalBridge,
  relaySessionManager,
  TERMINAL_CLI_LIMIT,
  TERMINAL_USER_LIMIT,
  type TerminalLifecycleEvent,
} from "./session-manager.js";
import { settleSocketHandler } from "./socket-handler.js";

const BROWSER_BUFFER_DETACH_BYTES = 4 * 1024 * 1024;
const BROWSER_JSON_MAX_BYTES = 64 * 1024;
const BROWSER_JSON_LIMIT = TERMINAL_BROWSER_JSON_LIMIT;
const BROWSER_JSON_WINDOW_MS = TERMINAL_BROWSER_JSON_WINDOW_MS;
/**
 * Accepted text frames a browser may have waiting or running at once. A slow
 * database lookup must not let one socket pile up work; a frame past this is
 * answered `rate_limited` unread and the accepted ones run on. Not below the
 * browser's per-window budget, so a conforming burst always fits
 * (TERMINAL_BROWSER_TEXT_PENDING_LIMIT).
 */
const BROWSER_TEXT_QUEUE_LIMIT = TERMINAL_BROWSER_TEXT_PENDING_LIMIT;
/** Per terminal tab. Key repeat runs at about 30 frames per second. */
const BROWSER_BINARY_LIMIT = 300;
/** Per terminal, across every viewer, so many tabs cannot multiply the CLI's input load. */
const TERMINAL_BINARY_LIMIT = 600;
const BROWSER_BINARY_WINDOW_MS = 10_000;
/** Limiter bucket for frames that do not name a terminal. */
const INVALID_BINARY_KEY = "";
/**
 * A refused text frame this small is read for its `requestId` and
 * `terminalId`, so the refusal answers that frame. Every schema-valid frame
 * fits (the largest, an `open` with a browser identity, is under 1.5 KiB);
 * reading it costs about as much as the error frame sent back.
 */
const BROWSER_JSON_ECHO_MAX_BYTES = 4096;

/**
 * Client-chosen, echoed by every answer the relay gives that frame directly
 * (`terminals` to a list, `opening`, `attaching`, `closed`, `detached` self,
 * a Decline's immediate `started`, and every error, including a rate-limit
 * or validation refusal), so the browser can tell which of its frames an
 * answer is for. Later events about a terminal (`pending`, `opened`,
 * `attached`, `rejected`, `exit`, pushes) are not answers to one frame and
 * carry none.
 */
const browserRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const browserIdentitySchema = z
  .object({
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .optional(),
  })
  .strict();

const requestIdField = { requestId: browserRequestIdSchema.optional() };

const browserClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list"), ...requestIdField }).strict(),
  z
    .object({
      type: z.literal("open"),
      ...requestIdField,
      cliDeviceId: z.string().trim().min(1).max(128),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
      publicKey: uncompressedP256PublicKeySchema,
      nonce: base64Url16ByteSchema,
      identity: browserIdentitySchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("auth"),
      ...requestIdField,
      terminalId: base64Url16ByteSchema,
      signature: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("attach"),
      ...requestIdField,
      terminalId: base64Url16ByteSchema,
      publicKey: uncompressedP256PublicKeySchema,
      nonce: base64Url16ByteSchema,
      identity: browserIdentitySchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("close"), ...requestIdField, terminalId: base64Url16ByteSchema })
    .strict(),
  z
    .object({ type: z.literal("decline"), ...requestIdField, terminalId: base64Url16ByteSchema })
    .strict(),
  z
    .object({ type: z.literal("detach"), ...requestIdField, terminalId: base64Url16ByteSchema })
    .strict(),
]);

/** What an answer to one browser frame names, so the browser can match it. */
type FrameRef = { terminalId?: string; requestId?: string };

/** The well-formed `terminalId` and `requestId` of a parsed frame, if any. */
function frameRefOf(parsed: unknown): FrameRef {
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const terminalId = base64Url16ByteSchema.safeParse(record.terminalId);
  const requestId = browserRequestIdSchema.safeParse(record.requestId);
  return {
    ...(terminalId.success ? { terminalId: terminalId.data } : {}),
    ...(requestId.success ? { requestId: requestId.data } : {}),
  };
}

/** `frameRefOf` for a raw frame refused before parsing; bounded in size. */
function rawFrameRef(frame: string): FrameRef {
  if (frame.length > BROWSER_JSON_ECHO_MAX_BYTES) return {};
  try {
    return frameRefOf(JSON.parse(frame));
  } catch {
    return {};
  }
}

export type TerminalAvailabilityReason =
  | "ok"
  | "not_granted"
  | "device_disabled"
  | "cli_too_old"
  | "unsupported"
  | "offline";

type TerminalErrorCode =
  | TerminalAvailabilityReason
  | "not_found"
  | "limit"
  | "invalid"
  | "rate_limited"
  | "input_dropped";

type BrowserConn = {
  id: string;
  socket: RelaySocket;
  userId: string;
  sessionId: string;
  /**
   * The admin acting through an impersonation session (Better Auth
   * `session.impersonatedBy`), or null. Revoking that admin closes this
   * connection too.
   */
  impersonatedBy: string | null;
  /**
   * False from registration until the admission read passed
   * ({@link admitBrowserConnection}). A pending connection is revocable like
   * an admitted one, but no frame of it runs and nothing is pushed to it.
   */
  admitted: boolean;
  /** Settles once admission ends (admitted, refused or forgotten). */
  admission: { promise: Promise<void>; settle: () => void };
  /** Accepted text frames not yet finished. Bounded by BROWSER_TEXT_QUEUE_LIMIT. */
  pendingText: number;
};

type BrowserConnInput = {
  socket: RelaySocket;
  userId: string;
  sessionId: string;
  impersonatedBy?: string | null;
};

function admissionGate(): BrowserConn["admission"] {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, settle };
}

type CliListRow = {
  id: string;
  slug: string;
  status: string;
  allowHumanTerminal: boolean;
  reportedHumanTerminal: boolean | null;
  reportedTerminalSupported: boolean | null;
  relayProtocolVersion: string | null;
};

const cliListSelect = {
  id: true,
  slug: true,
  status: true,
  allowHumanTerminal: true,
  reportedHumanTerminal: true,
  reportedTerminalSupported: true,
  relayProtocolVersion: true,
} as const;

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function terminalAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const appOrigin = originOf(env.BETTER_AUTH_URL);
  const devOrigin = originOf(env.CORS_ORIGIN);
  if (appOrigin) origins.add(appOrigin);
  if (devOrigin) origins.add(devOrigin);
  return origins;
}

/** Identity only travels with the terminal key it signs. */
function identityFields(
  publicKey: string | null,
  live: LiveCliFeatureSnapshot | null,
): { identityPublicKey: string | null; identitySignature: string | null } {
  const identity = publicKey ? (live?.terminalIdentity ?? null) : null;
  return {
    identityPublicKey: identity?.publicKey ?? null,
    identitySignature: identity?.signature ?? null,
  };
}

export function classifyTerminalAvailability(input: {
  status: string;
  allowHumanTerminal: boolean;
  relayProtocolVersion: string | null;
  reportedHumanTerminal: boolean | null;
  reportedTerminalSupported: boolean | null;
  live: LiveCliFeatureSnapshot | null;
}): { available: boolean; reason: TerminalAvailabilityReason; publicKey: string | null } {
  const live = input.live;
  const interactive = relayProtocolAtLeast(live?.protocolVersion, "2.4");
  const publicKey = interactive ? (live?.terminalPublicKey ?? null) : null;
  if (input.status === "REVOKED") {
    return { available: false, reason: "device_disabled", publicKey };
  }
  if (!input.allowHumanTerminal) {
    return { available: false, reason: "not_granted", publicKey };
  }
  if (!live || !interactive) {
    if (live) return { available: false, reason: "cli_too_old", publicKey };
    const neverReported =
      !relayProtocolAtLeast(input.relayProtocolVersion, "2.4") ||
      input.reportedHumanTerminal === null;
    return { available: false, reason: neverReported ? "cli_too_old" : "offline", publicKey };
  }
  if (!live.humanTerminal) return { available: false, reason: "device_disabled", publicKey };
  if (!live.terminalSupported) return { available: false, reason: "unsupported", publicKey };
  return { available: true, reason: "ok", publicKey };
}

function errorKind(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

function errorMessage(code: TerminalErrorCode): string {
  if (code === "not_found") return "CLI device not found.";
  if (code === "not_granted") return "Browser terminal is not granted for this CLI.";
  if (code === "device_disabled") return "Browser terminal is disabled for this CLI.";
  if (code === "cli_too_old") return "This CLI does not support browser terminals.";
  if (code === "unsupported") return "Browser terminal is not supported on this CLI.";
  if (code === "offline") return "CLI is offline.";
  if (code === "limit") return "Terminal limit reached.";
  if (code === "input_dropped") return "Terminal input was dropped.";
  if (code === "rate_limited") return "Too many terminal messages; try again shortly.";
  return "Invalid terminal message.";
}

function availabilityFor(row: CliListRow, live: LiveCliFeatureSnapshot | null) {
  return classifyTerminalAvailability({
    status: row.status,
    allowHumanTerminal: row.allowHumanTerminal,
    relayProtocolVersion: row.relayProtocolVersion,
    reportedHumanTerminal: row.reportedHumanTerminal,
    reportedTerminalSupported: row.reportedTerminalSupported,
    live,
  });
}

/** UTF-8 size check without encoding the frame. */
function utf8ByteLengthExceeds(frame: string, maxBytes: number): boolean {
  // Each UTF-16 unit encodes to 1..3 UTF-8 bytes.
  if (frame.length > maxBytes) return true;
  if (frame.length * 3 <= maxBytes) return false;
  return Buffer.byteLength(frame, "utf8") > maxBytes;
}

export class TerminalBrowserHub {
  private bySocket = new Map<RelaySocket, BrowserConn>();
  private byId = new Map<string, BrowserConn>();
  private jsonAt = new Map<string, number[]>();
  private binaryAt = new Map<string, Map<string, number[]>>();
  /** Input frames forwarded per terminal across all viewers. */
  private terminalBinaryAt = new Map<string, number[]>();
  private textChain = new Map<RelaySocket, Promise<void>>();
  /** `${connId}\0${terminalId}` while input is being dropped, so the browser hears about it once. */
  private dropNotified = new Set<string>();
  /** Users whose pushed terminal list is already queued for this tick. */
  private pushQueued = new Set<string>();

  /**
   * Closes every browser terminal socket, pending or admitted, that acts as
   * the user: its own sessions and sessions an admin impersonates through.
   * Called from the deletion listeners after the mark (or delete) committed.
   *
   * No in-process revocation state is kept. A handshake that authenticated
   * before the mark is either registered already (pending, so this closes
   * it) or registers later, and then its admission read, issued after
   * registration and so after this listener ran after the commit, sees the
   * marker or the missing session ({@link admitBrowserConnection}).
   */
  revokeTerminalAccessForUser(userId: string) {
    for (const conn of [...this.bySocket.values()]) {
      if (conn.userId !== userId && conn.impersonatedBy !== userId) continue;
      this.detachAll(conn);
      if (conn.socket.readyState === 1) conn.socket.close(4401, "user_deletion_pending");
      this.forgetConn(conn);
    }
  }

  /**
   * Registers a socket in the pending admission state. Synchronous, before any
   * database read, so a revocation that runs from here on finds it. Text
   * frames received while pending queue behind admission (same rate, size and
   * queue limits) and run in order once admitted.
   */
  register(input: BrowserConnInput): BrowserConn {
    const conn: BrowserConn = {
      id: randomUUID(),
      socket: input.socket,
      userId: input.userId,
      sessionId: input.sessionId,
      impersonatedBy: input.impersonatedBy ?? null,
      admitted: false,
      admission: admissionGate(),
      pendingText: 0,
    };
    const previous = this.bySocket.get(input.socket);
    if (previous) this.forgetConn(previous);
    this.bySocket.set(input.socket, conn);
    this.byId.set(conn.id, conn);
    this.textChain.set(input.socket, conn.admission.promise);
    return conn;
  }

  /**
   * Promotes a pending connection. Only the same registration (object
   * identity: not revoked, closed or replaced meanwhile) of a still-open
   * socket is admitted; otherwise the connection is forgotten and false is
   * returned.
   */
  admit(conn: BrowserConn): boolean {
    if (this.bySocket.get(conn.socket) !== conn) {
      conn.admission.settle();
      return false;
    }
    if (conn.socket.readyState !== 1) {
      this.forgetConn(conn);
      return false;
    }
    conn.admitted = true;
    conn.admission.settle();
    return true;
  }

  /** Ends a pending (or admitted) connection: closes the socket and forgets it. */
  refuse(conn: BrowserConn, code: number, reason: string) {
    const current = this.bySocket.get(conn.socket);
    if (current === conn) {
      this.detachAll(conn);
      this.forgetConn(conn);
    }
    conn.admission.settle();
    // A newer registration of the same socket is not this refusal's to close.
    if (current !== undefined && current !== conn) return;
    if (conn.socket.readyState === 1) conn.socket.close(code, reason);
  }

  /**
   * Registers an already-admitted connection without an admission read. For
   * tests; production sockets go through {@link admitBrowserConnection}.
   */
  accept(input: BrowserConnInput) {
    this.admit(this.register(input));
  }

  /**
   * Rate, size, and queue checks run synchronously on receipt, so a rejected
   * frame is never held. Accepted frames run one at a time, in order.
   */
  handleText(socket: RelaySocket, frame: string): Promise<void> {
    const conn = this.bySocket.get(socket);
    // Registered synchronously on open and forgotten on close, so an unknown
    // socket is one that already closed.
    if (!conn) return Promise.resolve();
    if (conn.pendingText >= BROWSER_TEXT_QUEUE_LIMIT) {
      // Refused unread, like a rate-limited frame, and answered so the
      // browser can send it again. The frames already accepted keep running;
      // the socket stays open. Checked before the rate window so a refused
      // frame does not use up a slot.
      this.sendError(conn, "rate_limited", rawFrameRef(frame));
      return Promise.resolve();
    }
    if (!this.allowJson(conn)) {
      // Answer the refused frame itself: a Decline refused here must reach a
      // state the person can retry, and an open must not shift the browser's
      // matching of later `opening` answers.
      this.sendError(conn, "rate_limited", rawFrameRef(frame));
      return Promise.resolve();
    }
    if (utf8ByteLengthExceeds(frame, BROWSER_JSON_MAX_BYTES)) {
      this.sendError(conn, "invalid");
      return Promise.resolve();
    }
    conn.pendingText += 1;
    const previous = this.textChain.get(socket) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.handleTextExclusive(conn, frame))
      .finally(() => {
        conn.pendingText -= 1;
      });
    this.textChain.set(socket, run);
    return run;
  }

  private allowJson(conn: BrowserConn, now = Date.now()): boolean {
    const recent = (this.jsonAt.get(conn.id) ?? []).filter(
      (stamp) => now - stamp < BROWSER_JSON_WINDOW_MS,
    );
    if (recent.length >= BROWSER_JSON_LIMIT) {
      this.jsonAt.set(conn.id, recent);
      return false;
    }
    recent.push(now);
    this.jsonAt.set(conn.id, recent);
    return true;
  }

  private allowBinary(conn: BrowserConn, terminalId: string, now = Date.now()): boolean {
    let byTerminal = this.binaryAt.get(conn.id);
    if (!byTerminal) {
      byTerminal = new Map();
      this.binaryAt.set(conn.id, byTerminal);
    }
    const recent = (byTerminal.get(terminalId) ?? []).filter(
      (stamp) => now - stamp < BROWSER_BINARY_WINDOW_MS,
    );
    if (recent.length >= BROWSER_BINARY_LIMIT) {
      byTerminal.set(terminalId, recent);
      return false;
    }
    recent.push(now);
    byTerminal.set(terminalId, recent);
    return true;
  }

  /** Checks the per-terminal aggregate without recording, so unknown ids add no entry. */
  private terminalInputAllowed(terminalId: string, now = Date.now()): boolean {
    const stamps = this.terminalBinaryAt.get(terminalId);
    if (!stamps) return true;
    const recent = stamps.filter((stamp) => now - stamp < BROWSER_BINARY_WINDOW_MS);
    if (recent.length === 0) {
      this.terminalBinaryAt.delete(terminalId);
      return true;
    }
    this.terminalBinaryAt.set(terminalId, recent);
    return recent.length < TERMINAL_BINARY_LIMIT;
  }

  private recordTerminalInput(terminalId: string, now = Date.now()) {
    const stamps = this.terminalBinaryAt.get(terminalId) ?? [];
    stamps.push(now);
    this.terminalBinaryAt.set(terminalId, stamps);
  }

  private forgetConn(conn: BrowserConn) {
    this.jsonAt.delete(conn.id);
    this.binaryAt.delete(conn.id);
    for (const key of this.dropNotified) {
      if (key.startsWith(`${conn.id}\0`)) this.dropNotified.delete(key);
    }
    // A socket-keyed entry may already belong to a newer registration.
    if (this.bySocket.get(conn.socket) === conn) {
      this.bySocket.delete(conn.socket);
      this.textChain.delete(conn.socket);
    }
    this.byId.delete(conn.id);
    // Frames queued behind a pending admission run now and no-op.
    conn.admission.settle();
  }

  /** Frames already passed the rate and size checks in `handleText`. */
  private async handleTextExclusive(conn: BrowserConn, frame: string) {
    // The socket may have closed, or been refused admission, while this frame
    // waited its turn.
    if (this.bySocket.get(conn.socket) !== conn || !conn.admitted) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      this.sendError(conn, "invalid");
      return;
    }
    const message = browserClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.sendError(conn, "invalid", frameRefOf(parsed));
      return;
    }
    const ref: FrameRef = {
      ...("terminalId" in message.data ? { terminalId: message.data.terminalId } : {}),
      ...(message.data.requestId ? { requestId: message.data.requestId } : {}),
    };
    try {
      await this.dispatchText(conn, message.data, ref);
    } catch (error) {
      // Every parsed frame gets an answer, also when handling it failed.
      this.sendError(conn, "invalid", ref);
      throw error;
    }
  }

  private async dispatchText(
    conn: BrowserConn,
    data: z.infer<typeof browserClientMessageSchema>,
    ref: FrameRef,
  ) {
    if (data.type === "list") {
      await this.sendTerminalList(conn, false, ref.requestId);
      return;
    }
    if (data.type === "open") {
      const terminalId = this.allocateTerminalId();
      // A new terminal has no viewers yet, so a fresh id cannot collide.
      const viewerId = randomBytes(16).toString("base64url");
      // From here on the terminal id names this open too.
      ref.terminalId = terminalId;
      this.send(conn, {
        type: "opening",
        terminalId,
        viewerId,
        ...(ref.requestId ? { requestId: ref.requestId } : {}),
      });
      await this.openTerminal(conn, data, terminalId, viewerId, ref);
      return;
    }
    if (data.type === "auth") {
      this.forwardAuth(conn, data.terminalId, data.signature, ref);
      return;
    }
    if (data.type === "attach") {
      this.attachTerminal(conn, data, ref);
      return;
    }
    if (data.type === "close") {
      // End session: ends the terminal for everyone, whatever runs in it.
      if (!relaySessionManager.closeTerminalFromBrowser(data.terminalId, conn.userId)) {
        this.sendError(conn, "not_found", ref);
        return;
      }
      // The terminal is gone from the relay now (a later list omits it), so
      // the browser can stop re-sending this close.
      this.send(conn, {
        type: "closed",
        terminalId: data.terminalId,
        ...(ref.requestId ? { requestId: ref.requestId } : {}),
      });
      return;
    }
    if (data.type === "decline") {
      // Decline an agent request: never ends a command whose Enter came first.
      const terminalId = data.terminalId;
      const answer = relaySessionManager.declineTerminalFromBrowser(
        terminalId,
        conn.userId,
        conn.id,
      );
      // Every answer names this Decline (`requestId`). `requested` is
      // answered later, to every socket whose Decline is out: the exit, or a
      // `decline` event saying the command started.
      if (answer === "started") {
        this.send(conn, {
          type: "decline",
          terminalId,
          outcome: "started",
          ...(ref.requestId ? { requestId: ref.requestId } : {}),
        });
      } else if (answer !== "requested") {
        this.sendError(conn, answer, ref);
      }
      return;
    }
    // Stop viewing (X button). `close` above ends the session for everyone.
    if (!relaySessionManager.detachTerminalViewer(data.terminalId, conn.userId, conn.id)) {
      this.sendError(conn, "not_found", ref);
      return;
    }
    this.send(conn, {
      type: "detached",
      terminalId: data.terminalId,
      reason: "self",
      ...(ref.requestId ? { requestId: ref.requestId } : {}),
    });
  }

  handleBinary(socket: RelaySocket, frame: ArrayBuffer) {
    const conn = this.bySocket.get(socket);
    if (!conn) return;
    if (!conn.admitted) {
      // Terminal input needs an attached terminal, which needs an admitted
      // socket. Refused loudly, never dropped silently.
      this.refuse(conn, 1008, "not_admitted");
      return;
    }
    let parsed: ReturnType<typeof parseRelayBinaryFrame>;
    try {
      parsed = parseRelayBinaryFrame(frame);
    } catch {
      if (this.allowBinary(conn, INVALID_BINARY_KEY)) this.sendError(conn, "invalid");
      return;
    }
    // The server stamps the viewer id. A browser never names a viewer or an epoch.
    if (
      parsed.metadata.type !== "term.sealed" ||
      parsed.metadata.viewerId !== undefined ||
      parsed.metadata.epoch !== undefined
    ) {
      if (this.allowBinary(conn, INVALID_BINARY_KEY)) this.sendError(conn, "invalid");
      return;
    }
    const { terminalId } = parsed.metadata;
    const dropKey = `${conn.id}\0${terminalId}`;
    if (!this.allowBinary(conn, terminalId) || !this.terminalInputAllowed(terminalId)) {
      this.notifyDropped(conn, terminalId, dropKey);
      return;
    }
    const forwarded = relaySessionManager.forwardBrowserSealed(
      terminalId,
      conn.userId,
      conn.id,
      parsed.metadata.seq,
      parsed.body,
    );
    if (forwarded === "missing") {
      // Unknown ids must not grow the per-terminal limiter map.
      this.binaryAt.get(conn.id)?.delete(terminalId);
      this.dropNotified.delete(dropKey);
      this.sendError(conn, "not_found", terminalId);
      return;
    }
    if (forwarded === "dropped") {
      this.notifyDropped(conn, terminalId, dropKey);
      return;
    }
    this.recordTerminalInput(terminalId);
    this.dropNotified.delete(dropKey);
  }

  /** Tell the browser once per run of dropped frames. The CLI tolerates seq gaps. */
  private notifyDropped(conn: BrowserConn, terminalId: string, dropKey: string) {
    if (this.dropNotified.has(dropKey)) return;
    this.dropNotified.add(dropKey);
    this.sendError(conn, "input_dropped", terminalId);
  }

  handleClose(socket: RelaySocket) {
    const conn = this.bySocket.get(socket);
    if (!conn) return;
    this.detachAll(conn);
    this.forgetConn(conn);
  }

  closeAll() {
    for (const conn of [...this.bySocket.values()]) {
      this.detachAll(conn);
      if (conn.socket.readyState === 1) conn.socket.close(1001, "shutdown");
      this.forgetConn(conn);
    }
  }

  async recheckSessions(now = Date.now()) {
    // A terminal can end without an exit event reaching here (an unspawned
    // open that was refused). Its input stamps age out on this sweep.
    for (const terminalId of [...this.terminalBinaryAt.keys()]) {
      this.terminalInputAllowed(terminalId, now);
    }
    const conns = [...this.bySocket.values()];
    if (conns.length === 0) return;
    // Same force-2FA policy as protected dashboard procedures. A failed lookup
    // skips only this sweep's 2FA check, like a failed session lookup below.
    let twoFactorRequired: boolean | null = null;
    try {
      twoFactorRequired = await isForceTwoFactorRequired();
    } catch (error) {
      console.error("[terminal] two-factor policy recheck failed", errorKind(error));
    }
    for (const conn of conns) {
      let row: {
        expiresAt: Date;
        userId: string;
        user: {
          twoFactorEnabled: boolean | null;
          deletionRequestedAt: Date | null;
          banned: boolean | null;
          banExpires: Date | null;
        } | null;
      } | null = null;
      try {
        row = await prisma.session.findUnique({
          where: { id: conn.sessionId },
          select: {
            expiresAt: true,
            userId: true,
            user: {
              select: {
                twoFactorEnabled: true,
                deletionRequestedAt: true,
                banned: true,
                banExpires: true,
              },
            },
          },
        });
      } catch (error) {
        console.error("[terminal] session recheck failed", errorKind(error));
        continue;
      }
      if (!row || row.userId !== conn.userId || row.expiresAt.getTime() <= now) {
        this.expire(conn);
        continue;
      }
      if (row.user && userCredentialAccessBlocked(row.user, new Date(now))) {
        this.expire(conn, "user_deletion_pending");
        continue;
      }
      if (twoFactorRequired === true && !row.user?.twoFactorEnabled) {
        this.expire(conn, "two_factor_required");
      }
    }
  }

  onTerminalEvent(event: TerminalLifecycleEvent) {
    if (event.type === "sealed") {
      this.forwardSealedToViewers(event);
      return;
    }
    if (event.type === "list_changed") {
      this.pushTerminalLists(event.userId);
      return;
    }
    if (event.type === "exit") {
      this.terminalBinaryAt.delete(event.terminalId);
      for (const connId of event.connIds) {
        const conn = this.byId.get(connId);
        if (!conn) continue;
        this.send(conn, {
          type: "exit",
          terminalId: event.terminalId,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.signal !== undefined ? { signal: event.signal } : {}),
          ...(event.supervisedStatus !== undefined
            ? { supervisedStatus: event.supervisedStatus }
            : {}),
        });
      }
      return;
    }
    if (event.type === "decline") {
      for (const connId of event.connIds) {
        const conn = this.byId.get(connId);
        if (!conn) continue;
        this.send(conn, { type: "decline", terminalId: event.terminalId, outcome: event.outcome });
      }
      return;
    }
    if (event.type === "viewers") {
      for (const recipient of event.recipients) {
        const conn = this.byId.get(recipient.connId);
        if (!conn) continue;
        this.send(conn, {
          type: "viewers",
          terminalId: event.terminalId,
          count: event.count,
          writer: recipient.writer,
        });
      }
      return;
    }
    const conn = this.byId.get(event.connId);
    if (!conn) return;
    if (event.type === "input_dropped") {
      // The CLI already sends this once per run of drops.
      this.sendError(conn, "input_dropped", event.terminalId);
      return;
    }
    if (event.type === "pending") {
      this.send(conn, {
        type: "pending",
        terminalId: event.terminalId,
        cliPublicKey: event.cliPublicKey,
        cliNonce: event.cliNonce,
        ...(event.approvalCode ? { approvalCode: event.approvalCode } : {}),
      });
      return;
    }
    if (event.type === "opened" || event.type === "attached") {
      this.send(conn, {
        type: event.type,
        terminalId: event.terminalId,
        cliPublicKey: event.cliPublicKey,
        cliNonce: event.cliNonce,
      });
      return;
    }
    if (event.type === "rejected") {
      this.send(conn, {
        type: "rejected",
        terminalId: event.terminalId,
        reason: event.reason,
        ...(event.approvalCode ? { approvalCode: event.approvalCode } : {}),
      });
      return;
    }
    // 2.4: another tab took this terminal.
    this.send(conn, { type: "detached", terminalId: event.terminalId });
  }

  /**
   * One CLI frame, one or many viewers. A viewer whose socket is backed up past
   * the limit is detached alone; the others keep receiving.
   */
  private forwardSealedToViewers(event: Extract<TerminalLifecycleEvent, { type: "sealed" }>) {
    let frame: ArrayBuffer | null = null;
    for (const connId of event.connIds) {
      const conn = this.byId.get(connId);
      if (!conn) continue;
      if ((conn.socket.bufferedAmount ?? 0) > BROWSER_BUFFER_DETACH_BYTES) {
        relaySessionManager.detachTerminalViewer(event.terminalId, conn.userId, conn.id);
        this.send(conn, { type: "detached", terminalId: event.terminalId, reason: "slow" });
        continue;
      }
      if (conn.socket.readyState !== 1) continue;
      frame ??= encodeRelayBinaryFrame(
        {
          type: "term.sealed",
          terminalId: event.terminalId,
          seq: event.seq,
          ...(event.epoch !== undefined ? { epoch: event.epoch } : {}),
        },
        event.body,
      );
      conn.socket.send(frame);
    }
  }

  /**
   * Supervised requests appear, change, and end without a browser asking.
   * Every open socket of that user gets a fresh list, marked `pushed`. The
   * list is a full snapshot as of its arrival.
   */
  private pushTerminalLists(userId: string) {
    // Several changes in one tick (accept, then list) make one push.
    if (this.pushQueued.has(userId)) return;
    this.pushQueued.add(userId);
    queueMicrotask(() => {
      this.pushQueued.delete(userId);
      for (const conn of [...this.bySocket.values()]) {
        if (conn.userId !== userId || !this.isLive(conn)) continue;
        settleSocketHandler("terminal list push", this.sendTerminalList(conn, true));
      }
    });
  }

  private async sendTerminalList(conn: BrowserConn, pushed = false, requestId?: string) {
    const rows = await prisma.cliDevice.findMany({
      where: { userId: conn.userId },
      orderBy: { createdAt: "asc" },
      select: cliListSelect,
    });
    if (pushed && !this.isLive(conn)) return;
    const live = relaySessionManager.getLiveCliFeatures(rows.map((row) => row.id));
    this.send(conn, {
      type: "terminals",
      ...(pushed ? { pushed: true } : {}),
      ...(requestId ? { requestId } : {}),
      clis: rows.map((row) => {
        const availability = availabilityFor(row, live.get(row.id) ?? null);
        return {
          cliDeviceId: row.id,
          slug: row.slug,
          available: availability.available,
          publicKey: availability.publicKey,
          reason: availability.reason,
          // 2.5 CLIs: several tabs can view one terminal (v2 terminal crypto).
          terminalViewers: relayProtocolAtLeast(live.get(row.id)?.protocolVersion, "2.5"),
          // 2.5 CLI identity, relayed unverified. Browsers check the signature
          // over `publicKey` and this slug, then pin the key per cliDeviceId.
          ...identityFields(availability.publicKey, live.get(row.id) ?? null),
        };
      }),
      terminals: relaySessionManager.listTerminalsForUser(conn.userId, conn.id),
    });
  }

  private allocateTerminalId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const terminalId = randomBytes(16).toString("base64url");
      if (!relaySessionManager.hasTerminal(terminalId)) return terminalId;
    }
    return randomBytes(16).toString("base64url");
  }

  private forwardAuth(conn: BrowserConn, terminalId: string, signature: string, ref: FrameRef) {
    const result = relaySessionManager.forwardTerminalAuth(
      terminalId,
      conn.userId,
      conn.id,
      signature,
    );
    if (result === "not_found") this.sendError(conn, "not_found", ref);
  }

  private async openTerminal(
    conn: BrowserConn,
    message: Extract<z.infer<typeof browserClientMessageSchema>, { type: "open" }>,
    terminalId: string,
    viewerId: string,
    /** Names the frame and, since `opening`, the terminal made for it. */
    ref: FrameRef,
  ) {
    const row = await this.ownedDevice(conn.userId, message.cliDeviceId);
    // The browser may have gone while the lookup ran. Starting now would leave
    // a shell with a phantom viewer holding a terminal slot.
    if (!this.isLive(conn)) return;
    if (!row) {
      this.sendError(conn, "not_found", ref);
      return;
    }
    const live = relaySessionManager.getLiveCliFeatures([row.id]).get(row.id) ?? null;
    const availability = availabilityFor(row, live);
    if (!availability.available) {
      this.sendError(conn, availability.reason, ref);
      return;
    }
    const approvalRequired = live?.terminalApproval === true;
    const counts = relaySessionManager.terminalCounts(conn.userId, row.id);
    if (
      !approvalRequired &&
      (counts.user >= TERMINAL_USER_LIMIT || counts.cli >= TERMINAL_CLI_LIMIT)
    ) {
      this.sendError(conn, "limit", ref);
      return;
    }
    const started = relaySessionManager.startTerminal({
      terminalId,
      userId: conn.userId,
      cliDeviceId: row.id,
      cols: message.cols,
      rows: message.rows,
      browserPublicKey: message.publicKey,
      browserNonce: message.nonce,
      ...(message.identity ? { identity: message.identity } : {}),
      connId: conn.id,
      viewerId,
    });
    if (!started) this.sendError(conn, "offline", ref);
  }

  private attachTerminal(
    conn: BrowserConn,
    message: Extract<z.infer<typeof browserClientMessageSchema>, { type: "attach" }>,
    ref: FrameRef,
  ) {
    if (!this.isLive(conn)) return;
    const result = relaySessionManager.attachTerminal({
      terminalId: message.terminalId,
      userId: conn.userId,
      connId: conn.id,
      browserPublicKey: message.publicKey,
      browserNonce: message.nonce,
      ...(message.identity ? { identity: message.identity } : {}),
    });
    if (!result.ok) {
      this.sendError(conn, result.error === "limit" ? "limit" : "not_found", ref);
      return;
    }
    this.send(conn, {
      type: "attaching",
      terminalId: message.terminalId,
      viewerId: result.viewerId,
      ...(ref.requestId ? { requestId: ref.requestId } : {}),
    });
  }

  private async ownedDevice(userId: string, cliDeviceId: string): Promise<CliListRow | null> {
    return prisma.cliDevice.findFirst({
      where: { id: cliDeviceId, userId },
      select: cliListSelect,
    });
  }

  private detachAll(conn: BrowserConn) {
    relaySessionManager.releaseBrowserViewer(conn.userId, conn.id);
  }

  /** Admitted, still registered and open, so terminal work on its behalf may proceed. */
  private isLive(conn: BrowserConn): boolean {
    return conn.admitted && this.bySocket.get(conn.socket) === conn && conn.socket.readyState === 1;
  }

  private expire(
    conn: BrowserConn,
    reason: "session_expired" | "two_factor_required" | "user_deletion_pending" = "session_expired",
  ) {
    this.detachAll(conn);
    if (conn.socket.readyState === 1) conn.socket.close(4401, reason);
    this.forgetConn(conn);
  }

  private sendError(conn: BrowserConn, code: TerminalErrorCode, target?: string | FrameRef) {
    const ref = typeof target === "string" ? { terminalId: target } : (target ?? {});
    this.send(conn, {
      type: "error",
      code,
      message: errorMessage(code),
      ...(ref.terminalId ? { terminalId: ref.terminalId } : {}),
      ...(ref.requestId ? { requestId: ref.requestId } : {}),
    });
  }

  private send(conn: BrowserConn, message: unknown) {
    if (conn.socket.readyState !== 1) return;
    conn.socket.send(JSON.stringify(message));
  }
}

export const terminalBrowserHub = new TerminalBrowserHub();
registerTerminalBridge({
  onTerminalEvent(event) {
    terminalBrowserHub.onTerminalEvent(event);
  },
});

/**
 * Registers a browser terminal socket, then admits it after one read of its
 * session and owner.
 *
 * Order (DEL-STATE): `register` runs synchronously, before the read. The
 * deletion mark deletes the user's sessions (and the sessions it impersonates
 * through) in the transaction that sets the marker, and its listener runs
 * after that commit. So either the read's snapshot includes the mark (the
 * session is gone or the owner is marked: refused here), or the mark committed
 * after the read began, hence after registration, and the listener finds and
 * closes the pending connection. No in-process revocation state is needed.
 *
 * Fails closed: a missing or foreign or expired session, a missing user row, a
 * deletion marker or an active ban close the socket (4401), and a read error
 * closes it (1011) before rethrowing for the caller's log. A socket that
 * closed or was revoked during the read is never registered.
 */
export async function admitBrowserConnection(input: BrowserConnInput): Promise<void> {
  const conn = terminalBrowserHub.register(input);
  let row: {
    userId: string;
    expiresAt: Date;
    user: { deletionRequestedAt: Date | null; banned: boolean | null; banExpires: Date | null };
  } | null;
  try {
    row = await prisma.session.findUnique({
      where: { id: input.sessionId },
      select: {
        userId: true,
        expiresAt: true,
        user: { select: { deletionRequestedAt: true, banned: true, banExpires: true } },
      },
    });
  } catch (error) {
    terminalBrowserHub.refuse(conn, 1011, "admission_failed");
    throw error;
  }
  const now = new Date();
  if (!row || row.userId !== input.userId || row.expiresAt.getTime() <= now.getTime()) {
    terminalBrowserHub.refuse(conn, 4401, "session_expired");
    return;
  }
  // `user` is a required relation; a vanished row still refuses.
  if (!row.user || userCredentialAccessBlocked(row.user, now)) {
    terminalBrowserHub.refuse(conn, 4401, "user_deletion_pending");
    return;
  }
  terminalBrowserHub.admit(conn);
}

type TerminalWsContext = WSContext<WebSocketLike>;
const browserSockets = new WeakMap<TerminalWsContext, RelaySocket>();

function browserSocketFor(ws: TerminalWsContext): RelaySocket {
  const existing = browserSockets.get(ws);
  if (existing) return existing;
  const socket: RelaySocket = {
    get readyState() {
      return ws.readyState;
    },
    get bufferedAmount() {
      const raw = ws.raw;
      return typeof raw === "object" && raw && "bufferedAmount" in raw
        ? Number(raw.bufferedAmount)
        : 0;
    },
    send(data: string | ArrayBuffer | Uint8Array) {
      if (data instanceof Uint8Array) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        ws.send(copy.buffer);
        return;
      }
      ws.send(data);
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
  };
  browserSockets.set(ws, socket);
  return socket;
}

type TerminalVariables = { session: Session | null };

export function createTerminalWebsocketMiddleware(): MiddlewareHandler<{
  Variables: TerminalVariables;
}> {
  const ipLimit = createRateLimiterMiddleware(rpcLimiter, {
    resolveKey: (context) => resolveClientIp(context),
  });
  const rateLimit = createRateLimiterMiddleware(rpcLimiter);
  return async (c, next) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "WebSocket upgrade required." }, 426);
    }
    if (relaySessionManager.isDraining()) {
      return c.json({ error: "Server is shutting down." }, 503);
    }
    const ipLimited = await ipLimit(c, async () => undefined);
    if (ipLimited instanceof Response) return ipLimited;
    await sessionMiddleware(c, async () => undefined);
    const session = c.get("session");
    if (!session?.user?.id || !session.session?.id) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const origin = c.req.header("origin");
    if (!origin) return c.json({ error: "Origin required." }, 403);
    const normalized = originOf(origin);
    if (!normalized || !terminalAllowedOrigins().has(normalized)) {
      return c.json({ error: "Cross-site request blocked." }, 403);
    }
    // Same decision as protected dashboard procedures: an unenrolled user
    // under the force-2FA policy gets no shell.
    if ((await isForceTwoFactorRequired()) && !session.user.twoFactorEnabled) {
      return c.json({ error: "Two-factor authentication setup is required." }, 403);
    }
    const limited = await rateLimit(c, async () => undefined);
    if (limited instanceof Response) return limited;
    await next();
  };
}

/**
 * The socket events of one upgraded browser terminal connection, for the
 * session the middleware authenticated. Exported for the wiring tests.
 */
export function terminalSocketEvents(session: Session | null): WSEvents<WebSocketLike> {
  return {
    onOpen(_event, ws) {
      if (!session?.user?.id || !session.session?.id) {
        ws.close(4401, "session_expired");
        return;
      }
      const socket = browserSocketFor(ws);
      // Registers synchronously (pending), before this handler returns and
      // before any frame of the socket is handled.
      settleSocketHandler(
        "browser admit",
        admitBrowserConnection({
          socket,
          userId: session.user.id,
          sessionId: session.session.id,
          impersonatedBy: session.session.impersonatedBy ?? null,
        }),
      );
    },
    onMessage(event, ws) {
      const socket = browserSocketFor(ws);
      if (typeof event.data === "string") {
        settleSocketHandler("browser text", terminalBrowserHub.handleText(socket, event.data));
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        terminalBrowserHub.handleBinary(socket, event.data);
      }
    },
    onClose(_event, ws) {
      const socket = browserSocketFor(ws);
      terminalBrowserHub.handleClose(socket);
      browserSockets.delete(ws);
    },
    onError(_event, ws) {
      const socket = browserSocketFor(ws);
      terminalBrowserHub.handleClose(socket);
      browserSockets.delete(ws);
    },
  };
}

export function terminalUpgradeHandler() {
  return upgradeWebSocket((c: Context<{ Variables: TerminalVariables }>) =>
    terminalSocketEvents(c.get("session")),
  );
}
