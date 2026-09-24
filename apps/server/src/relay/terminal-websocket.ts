import { randomBytes, randomUUID } from "node:crypto";
import { upgradeWebSocket, type WebSocketLike } from "@hono/node-server";
import type { LiveCliFeatureSnapshot } from "@ws-model-proxy/api/context";
import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
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
const BROWSER_JSON_LIMIT = 20;
const BROWSER_JSON_WINDOW_MS = 10_000;
/**
 * Accepted text frames a browser may have waiting or running at once. A slow
 * database lookup must not let one socket pile up work; past this the socket
 * is closed with 1008.
 */
const BROWSER_TEXT_QUEUE_LIMIT = 8;
/** Per terminal tab. Key repeat runs at about 30 frames per second. */
const BROWSER_BINARY_LIMIT = 300;
/** Per terminal, across every viewer, so many tabs cannot multiply the CLI's input load. */
const TERMINAL_BINARY_LIMIT = 600;
const BROWSER_BINARY_WINDOW_MS = 10_000;
/** Limiter bucket for frames that do not name a terminal. */
const INVALID_BINARY_KEY = "";

const browserIdentitySchema = z
  .object({
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .optional(),
  })
  .strict();

const browserClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list") }).strict(),
  z
    .object({
      type: z.literal("open"),
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
      terminalId: base64Url16ByteSchema,
      signature: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("attach"),
      terminalId: base64Url16ByteSchema,
      publicKey: uncompressedP256PublicKeySchema,
      nonce: base64Url16ByteSchema,
      identity: browserIdentitySchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("close"), terminalId: base64Url16ByteSchema }).strict(),
  z.object({ type: z.literal("detach"), terminalId: base64Url16ByteSchema }).strict(),
]);

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
  | "input_dropped";

type BrowserConn = {
  id: string;
  socket: RelaySocket;
  userId: string;
  sessionId: string;
  /** Accepted text frames not yet finished. Bounded by BROWSER_TEXT_QUEUE_LIMIT. */
  pendingText: number;
};

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

  accept(input: { socket: RelaySocket; userId: string; sessionId: string }) {
    const conn: BrowserConn = { id: randomUUID(), pendingText: 0, ...input };
    this.bySocket.set(input.socket, conn);
    this.byId.set(conn.id, conn);
  }

  /**
   * Rate, size, and queue checks run synchronously on receipt, so a rejected
   * frame is never held. Accepted frames run one at a time, in order.
   */
  handleText(socket: RelaySocket, frame: string): Promise<void> {
    const conn = this.bySocket.get(socket);
    if (!conn) return Promise.resolve();
    if (!this.allowJson(conn)) {
      this.sendError(conn, "invalid");
      return Promise.resolve();
    }
    if (utf8ByteLengthExceeds(frame, BROWSER_JSON_MAX_BYTES)) {
      this.sendError(conn, "invalid");
      return Promise.resolve();
    }
    if (conn.pendingText >= BROWSER_TEXT_QUEUE_LIMIT) {
      this.detachAll(conn);
      if (conn.socket.readyState === 1) conn.socket.close(1008, "too_many_pending");
      this.forgetConn(conn);
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
    this.textChain.delete(conn.socket);
    this.bySocket.delete(conn.socket);
    this.byId.delete(conn.id);
  }

  /** Frames already passed the rate and size checks in `handleText`. */
  private async handleTextExclusive(conn: BrowserConn, frame: string) {
    // The socket may have closed while this frame waited its turn.
    if (this.bySocket.get(conn.socket) !== conn) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      this.sendError(conn, "invalid");
      return;
    }
    const message = browserClientMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.sendError(conn, "invalid");
      return;
    }
    if (message.data.type === "list") {
      await this.sendTerminalList(conn);
      return;
    }
    if (message.data.type === "open") {
      const terminalId = this.allocateTerminalId();
      // A new terminal has no viewers yet, so a fresh id cannot collide.
      const viewerId = randomBytes(16).toString("base64url");
      this.send(conn, { type: "opening", terminalId, viewerId });
      await this.openTerminal(conn, message.data, terminalId, viewerId);
      return;
    }
    if (message.data.type === "auth") {
      this.forwardAuth(conn, message.data.terminalId, message.data.signature);
      return;
    }
    if (message.data.type === "attach") {
      this.attachTerminal(conn, message.data);
      return;
    }
    if (message.data.type === "close") {
      if (!relaySessionManager.closeTerminalFromBrowser(message.data.terminalId, conn.userId)) {
        this.sendError(conn, "not_found", message.data.terminalId);
      }
      return;
    }
    // Stop viewing (X button). `close` above ends the session for everyone.
    if (!relaySessionManager.detachTerminalViewer(message.data.terminalId, conn.userId, conn.id)) {
      this.sendError(conn, "not_found", message.data.terminalId);
      return;
    }
    this.send(conn, { type: "detached", terminalId: message.data.terminalId, reason: "self" });
  }

  handleBinary(socket: RelaySocket, frame: ArrayBuffer) {
    const conn = this.bySocket.get(socket);
    if (!conn) return;
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
        user: { twoFactorEnabled: boolean | null } | null;
      } | null = null;
      try {
        row = await prisma.session.findUnique({
          where: { id: conn.sessionId },
          select: { expiresAt: true, userId: true, user: { select: { twoFactorEnabled: true } } },
        });
      } catch (error) {
        console.error("[terminal] session recheck failed", errorKind(error));
        continue;
      }
      if (!row || row.userId !== conn.userId || row.expiresAt.getTime() <= now) {
        this.expire(conn);
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
        });
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

  private async sendTerminalList(conn: BrowserConn) {
    const rows = await prisma.cliDevice.findMany({
      where: { userId: conn.userId },
      orderBy: { createdAt: "asc" },
      select: cliListSelect,
    });
    const live = relaySessionManager.getLiveCliFeatures(rows.map((row) => row.id));
    this.send(conn, {
      type: "terminals",
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

  private forwardAuth(conn: BrowserConn, terminalId: string, signature: string) {
    const result = relaySessionManager.forwardTerminalAuth(
      terminalId,
      conn.userId,
      conn.id,
      signature,
    );
    if (result === "not_found") this.sendError(conn, "not_found", terminalId);
  }

  private async openTerminal(
    conn: BrowserConn,
    message: Extract<z.infer<typeof browserClientMessageSchema>, { type: "open" }>,
    terminalId: string,
    viewerId: string,
  ) {
    const row = await this.ownedDevice(conn.userId, message.cliDeviceId);
    // The browser may have gone while the lookup ran. Starting now would leave
    // a shell with a phantom viewer holding a terminal slot.
    if (!this.isLive(conn)) return;
    if (!row) {
      this.sendError(conn, "not_found", terminalId);
      return;
    }
    const live = relaySessionManager.getLiveCliFeatures([row.id]).get(row.id) ?? null;
    const availability = availabilityFor(row, live);
    if (!availability.available) {
      this.sendError(conn, availability.reason, terminalId);
      return;
    }
    const approvalRequired = live?.terminalApproval === true;
    const counts = relaySessionManager.terminalCounts(conn.userId, row.id);
    if (
      !approvalRequired &&
      (counts.user >= TERMINAL_USER_LIMIT || counts.cli >= TERMINAL_CLI_LIMIT)
    ) {
      this.sendError(conn, "limit", terminalId);
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
    if (!started) this.sendError(conn, "offline", terminalId);
  }

  private attachTerminal(
    conn: BrowserConn,
    message: Extract<z.infer<typeof browserClientMessageSchema>, { type: "attach" }>,
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
      this.sendError(conn, result.error === "limit" ? "limit" : "not_found", message.terminalId);
      return;
    }
    this.send(conn, {
      type: "attaching",
      terminalId: message.terminalId,
      viewerId: result.viewerId,
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

  /** Still registered and open, so terminal work on its behalf may proceed. */
  private isLive(conn: BrowserConn): boolean {
    return this.bySocket.get(conn.socket) === conn && conn.socket.readyState === 1;
  }

  private expire(
    conn: BrowserConn,
    reason: "session_expired" | "two_factor_required" = "session_expired",
  ) {
    this.detachAll(conn);
    if (conn.socket.readyState === 1) conn.socket.close(4401, reason);
    this.forgetConn(conn);
  }

  private sendError(conn: BrowserConn, code: TerminalErrorCode, terminalId?: string) {
    this.send(conn, {
      type: "error",
      code,
      message: errorMessage(code),
      ...(terminalId ? { terminalId } : {}),
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

export function terminalUpgradeHandler() {
  return upgradeWebSocket((c: Context<{ Variables: TerminalVariables }>) => {
    const session = c.get("session");
    return {
      onOpen(_event, ws) {
        if (!session?.user?.id || !session.session?.id) {
          ws.close(4401, "session_expired");
          return;
        }
        terminalBrowserHub.accept({
          socket: browserSocketFor(ws),
          userId: session.user.id,
          sessionId: session.session.id,
        });
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
  });
}
