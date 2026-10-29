import type { NodeEvent } from "@ws-model-proxy/api/lib/node-events";

/**
 * The browser's node event streams (#255): `GET /api/dashboard/events` (./route.ts).
 *
 * Each signed-in tab holds one server-sent events stream. A committed node change
 * (`publishNodeEvent`, packages/api/src/lib/node-events.ts) goes to its owner's streams only,
 * as `event: node` with the node's id and what changed, never node data: the browser refetches
 * its queries. A stream also gets `retry`, a `hello` on open, a comment ping every
 * {@link NODE_EVENTS_PING_MS} (idle proxies keep it open; the browser detects a dead one), and
 * `event: unauthorized` before the server closes it for its session (sign-out, revocation,
 * expiry, a ban, a pending deletion, the force-2FA policy).
 *
 * Admission is two steps, so a sign-out can never race it: `reserve` counts the stream against
 * the caps and registers it synchronously before the route reads the session row; `activate`
 * opens it only if nothing ended the session meanwhile.
 *
 * In-process only, like the relay sessions it reports on (one web container).
 */

export const NODE_EVENTS_PING_MS = 25_000;
/** The browser's reconnect delay for a stream that ended without its own backoff. */
export const NODE_EVENTS_RETRY_MS = 3_000;
/** Bytes a stream may have queued unread before it is closed (the browser resyncs). */
export const NODE_EVENTS_MAX_QUEUED_BYTES = 64 * 1024;

export type NodeEventLimits = { perUser: number; perServer: number };
export const NODE_EVENTS_LIMITS: NodeEventLimits = { perUser: 16, perServer: 2048 };

export type UnauthorizedReason =
  | "session_ended"
  | "access_blocked"
  | "two_factor_required"
  | "user_deletion_pending";

export type SessionVerdict = "ok" | "ended" | "blocked" | "two_factor_required";

export type NodeEventSubscriber = {
  readonly userId: string;
  readonly sessionId: string;
  /** The admin who impersonates `userId` in this session, if any. */
  readonly impersonatedBy: string | null;
  state: "pending" | "open" | "closed";
  controller: ReadableStreamDefaultController<Uint8Array> | null;
};

export type ReserveResult =
  | { ok: true; subscriber: NodeEventSubscriber }
  | { ok: false; reason: "user_limit" | "server_limit" | "closing" };

const encoder = new TextEncoder();

function frame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const PING = encoder.encode(": ping\n\n");

export class NodeEventHub {
  private readonly byUser = new Map<string, Set<NodeEventSubscriber>>();
  private total = 0;
  private closing = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly limits: NodeEventLimits = NODE_EVENTS_LIMITS,
    private readonly pingMs: number = NODE_EVENTS_PING_MS,
  ) {}

  /** Open streams and pending admissions. */
  get size(): number {
    return this.total;
  }

  /**
   * Counts a new stream against the caps and registers it as pending. Synchronous: an
   * `endSession` or `closeUser` that runs from here on finds it.
   */
  reserve(input: {
    userId: string;
    sessionId: string;
    impersonatedBy?: string | null;
  }): ReserveResult {
    if (this.closing) return { ok: false, reason: "closing" };
    if (this.total >= this.limits.perServer) return { ok: false, reason: "server_limit" };
    const own = this.byUser.get(input.userId);
    if ((own?.size ?? 0) >= this.limits.perUser) return { ok: false, reason: "user_limit" };
    const subscriber: NodeEventSubscriber = {
      userId: input.userId,
      sessionId: input.sessionId,
      impersonatedBy: input.impersonatedBy ?? null,
      state: "pending",
      controller: null,
    };
    if (own) own.add(subscriber);
    else this.byUser.set(input.userId, new Set([subscriber]));
    this.total += 1;
    return { ok: true, subscriber };
  }

  /** Gives a pending admission back (its session check refused). */
  release(subscriber: NodeEventSubscriber): void {
    this.forget(subscriber);
  }

  /**
   * Opens a reserved stream. Null when it was closed while its session was read (sign-out,
   * deletion, shutdown): the route answers 401 or 503 instead.
   */
  activate(subscriber: NodeEventSubscriber): ReadableStream<Uint8Array> | null {
    if (subscriber.state !== "pending") return null;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          subscriber.controller = controller;
          subscriber.state = "open";
          controller.enqueue(encoder.encode(`retry: ${NODE_EVENTS_RETRY_MS}\n\n`));
          controller.enqueue(frame("hello", { v: 1 }));
        },
        cancel: () => {
          // The browser went away (or the response was aborted).
          subscriber.state = "closed";
          subscriber.controller = null;
          this.forget(subscriber);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: NODE_EVENTS_MAX_QUEUED_BYTES }),
    );
    this.ensurePing();
    return stream;
  }

  /** Delivers a committed change to its owner's open streams. */
  publish(event: NodeEvent): void {
    const subscribers = this.byUser.get(event.userId);
    if (!subscribers) return;
    const data =
      event.type === "node.connection"
        ? {
            v: 1,
            type: event.type,
            nodeId: event.nodeId,
            connection: event.connection,
            generation: event.generation,
            at: new Date().toISOString(),
          }
        : { v: 1, type: event.type, nodeId: event.nodeId, at: new Date().toISOString() };
    const bytes = frame("node", data);
    for (const subscriber of [...subscribers]) this.write(subscriber, bytes);
  }

  /** A dashboard session ended (its row was deleted): close its streams now. */
  endSession(sessionId: string, reason: UnauthorizedReason = "session_ended"): void {
    for (const subscriber of this.all()) {
      if (subscriber.sessionId === sessionId) this.end(subscriber, reason);
    }
  }

  /** The user (or the admin impersonating them) may no longer use the dashboard. */
  closeUser(userId: string, reason: UnauthorizedReason = "user_deletion_pending"): void {
    for (const subscriber of this.all()) {
      if (subscriber.userId === userId || subscriber.impersonatedBy === userId)
        this.end(subscriber, reason);
    }
  }

  /**
   * The 60 s backstop (relay-maintenance.ts): re-reads each session once and closes the streams
   * of one that expired or lost access. A failed read keeps that session's streams this round.
   */
  async recheckSessions(
    check: (input: { sessionId: string; userId: string }) => Promise<SessionVerdict>,
  ): Promise<void> {
    const sessions = new Map<string, NodeEventSubscriber>();
    for (const subscriber of this.all()) {
      if (subscriber.state === "open" && !sessions.has(subscriber.sessionId))
        sessions.set(subscriber.sessionId, subscriber);
    }
    for (const subscriber of sessions.values()) {
      let verdict: SessionVerdict;
      try {
        verdict = await check({ sessionId: subscriber.sessionId, userId: subscriber.userId });
      } catch (error) {
        console.error(
          "[node-events] session recheck failed",
          error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
        );
        continue;
      }
      if (verdict === "ok") continue;
      const reason: UnauthorizedReason =
        verdict === "ended"
          ? "session_ended"
          : verdict === "blocked"
            ? "access_blocked"
            : "two_factor_required";
      this.endSession(subscriber.sessionId, reason);
    }
  }

  /**
   * Shutdown: refuse new streams and end every open one, before the HTTP drain (an open stream
   * would hold it). No `unauthorized`: the browser reconnects to the next process.
   */
  closeAll(): void {
    this.closing = true;
    for (const subscriber of this.all()) this.end(subscriber, null);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private all(): NodeEventSubscriber[] {
    const out: NodeEventSubscriber[] = [];
    for (const set of this.byUser.values()) out.push(...set);
    return out;
  }

  private write(subscriber: NodeEventSubscriber, bytes: Uint8Array): void {
    const controller = subscriber.controller;
    if (subscriber.state !== "open" || !controller) return;
    // A reader that stopped reading: close it rather than queue without bound. The browser
    // reconnects and refetches, so nothing is lost.
    if ((controller.desiredSize ?? 0) < bytes.byteLength) {
      this.end(subscriber, null);
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {
      this.end(subscriber, null);
    }
  }

  private end(subscriber: NodeEventSubscriber, reason: UnauthorizedReason | null): void {
    const controller = subscriber.controller;
    const wasOpen = subscriber.state === "open";
    subscriber.state = "closed";
    subscriber.controller = null;
    this.forget(subscriber);
    if (!wasOpen || !controller) return;
    try {
      if (reason) controller.enqueue(frame("unauthorized", { reason }));
      controller.close();
    } catch {
      // Already closed or errored by the reader.
    }
  }

  private forget(subscriber: NodeEventSubscriber): void {
    const set = this.byUser.get(subscriber.userId);
    if (!set?.delete(subscriber)) return;
    this.total -= 1;
    if (set.size === 0) this.byUser.delete(subscriber.userId);
    if (this.total === 0 && this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private ensurePing(): void {
    if (this.pingTimer || this.closing) return;
    this.pingTimer = setInterval(() => {
      for (const subscriber of this.all()) this.write(subscriber, PING);
    }, this.pingMs);
    this.pingTimer.unref?.();
  }
}

export const nodeEventHub = new NodeEventHub();
