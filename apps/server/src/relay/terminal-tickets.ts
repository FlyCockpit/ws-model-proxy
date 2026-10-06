/**
 * One-use tickets for the browser terminal socket. `nodes.terminals.openTicket` and
 * `nodes.queued.run` mint one for a signed-in person's Better Auth session; the socket's
 * `open` redeems it (`terminal-websocket.ts`), which names the node and the terminal id the
 * procedure already audited.
 *
 * In memory, single process (the relay sockets live here too). A ticket is bound to its user
 * AND session, expires after {@link TERMINAL_TICKET_TTL_MS} and is gone after its first
 * presentation, whoever presents it. Only a digest of the ticket is kept.
 */
import { createHash, randomBytes } from "node:crypto";

export const TERMINAL_TICKET_TTL_MS = 60_000;
/** Unredeemed tickets one user may hold; minting past it drops their oldest. */
export const TERMINAL_TICKETS_PER_USER = 16;
/** 32 random bytes, base64url. */
export const TERMINAL_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type TicketEntry = {
  userId: string;
  sessionId: string;
  /** The admin acting through an impersonation session, or null. */
  impersonatedBy: string | null;
  nodeId: string;
  terminalId: string;
  expiresAt: number;
};

export type MintedTerminalTicket = { ticket: string; terminalId: string; expiresAt: Date };

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("base64url");
}

export class TerminalTicketStore {
  /** Digest -> entry, in mint order. */
  private byDigest = new Map<string, TicketEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = TERMINAL_TICKET_TTL_MS,
  ) {}

  mint(input: {
    userId: string;
    sessionId: string;
    impersonatedBy?: string | null;
    nodeId: string;
  }): MintedTerminalTicket {
    const now = this.now();
    this.prune(now);
    const held = [...this.byDigest].filter(([, entry]) => entry.userId === input.userId);
    for (const [key] of held.slice(0, Math.max(0, held.length - TERMINAL_TICKETS_PER_USER + 1))) {
      this.byDigest.delete(key);
    }
    const ticket = randomBytes(32).toString("base64url");
    const terminalId = randomBytes(16).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.byDigest.set(digest(ticket), {
      userId: input.userId,
      sessionId: input.sessionId,
      impersonatedBy: input.impersonatedBy ?? null,
      nodeId: input.nodeId,
      terminalId,
      expiresAt,
    });
    return { ticket, terminalId, expiresAt: new Date(expiresAt) };
  }

  /**
   * Redeems a ticket for the socket's user and session. The ticket is used up by this call
   * whatever the outcome: a ticket shown to the wrong session is burned, not kept for a retry.
   */
  redeem(input: {
    ticket: string;
    userId: string;
    sessionId: string;
  }): { nodeId: string; terminalId: string } | null {
    if (!TERMINAL_TICKET_PATTERN.test(input.ticket)) return null;
    const key = digest(input.ticket);
    const entry = this.byDigest.get(key);
    if (!entry) return null;
    this.byDigest.delete(key);
    if (entry.expiresAt <= this.now()) return null;
    if (entry.userId !== input.userId || entry.sessionId !== input.sessionId) return null;
    return { nodeId: entry.nodeId, terminalId: entry.terminalId };
  }

  /**
   * The user lost access (deletion mark, ban): their unredeemed tickets go, and those an admin
   * minted while impersonating as someone when that admin is the user.
   */
  revokeForUser(userId: string): void {
    for (const [key, entry] of this.byDigest) {
      if (entry.userId === userId || entry.impersonatedBy === userId) this.byDigest.delete(key);
    }
  }

  get size(): number {
    return this.byDigest.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.byDigest) {
      if (entry.expiresAt <= now) this.byDigest.delete(key);
    }
  }
}

export const terminalTicketStore = new TerminalTicketStore();
