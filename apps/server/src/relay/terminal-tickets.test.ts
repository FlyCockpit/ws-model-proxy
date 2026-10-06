import { describe, expect, it } from "vitest";
import {
  TERMINAL_TICKET_PATTERN,
  TERMINAL_TICKET_TTL_MS,
  TERMINAL_TICKETS_PER_USER,
  TerminalTicketStore,
} from "./terminal-tickets.js";

function store(start = 1_000_000) {
  const clock = { now: start };
  return { clock, tickets: new TerminalTicketStore(() => clock.now) };
}

const owner = { userId: "user-1", sessionId: "session-1" };

describe("terminal tickets", () => {
  it("mints a base64url ticket and a fresh 16-byte terminal id that expire after 60 s", () => {
    const { clock, tickets } = store();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(minted.ticket).toMatch(TERMINAL_TICKET_PATTERN);
    expect(Buffer.from(minted.terminalId, "base64url")).toHaveLength(16);
    expect(minted.expiresAt.getTime()).toBe(clock.now + TERMINAL_TICKET_TTL_MS);
    const other = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(other.ticket).not.toBe(minted.ticket);
    expect(other.terminalId).not.toBe(minted.terminalId);
  });

  it("redeems once for its user and session", () => {
    const { tickets } = store();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toEqual({
      kind: "open",
      nodeId: "node-1",
      terminalId: minted.terminalId,
    });
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toBeNull();
  });

  it("binds an attach ticket to its step and that step's operator terminal", () => {
    const { tickets } = store();
    const terminalId = Buffer.alloc(16, 7).toString("base64url");
    const minted = tickets.mint({
      ...owner,
      nodeId: "node-1",
      attach: { stepId: "step-1", terminalId },
    });
    expect(minted.terminalId).toBe(terminalId);
    expect(
      tickets.redeem({ userId: owner.userId, sessionId: "session-2", ticket: minted.ticket }),
    ).toBeNull();
    const again = tickets.mint({
      ...owner,
      nodeId: "node-1",
      attach: { stepId: "step-1", terminalId },
    });
    expect(tickets.redeem({ ...owner, ticket: again.ticket })).toEqual({
      kind: "attach",
      nodeId: "node-1",
      terminalId,
      stepId: "step-1",
    });
    expect(tickets.redeem({ ...owner, ticket: again.ticket })).toBeNull();
  });

  it("refuses an expired ticket", () => {
    const { clock, tickets } = store();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    clock.now += TERMINAL_TICKET_TTL_MS - 1;
    const fresh = tickets.mint({ ...owner, nodeId: "node-1" });
    clock.now += 1;
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toBeNull();
    expect(tickets.redeem({ ...owner, ticket: fresh.ticket })).not.toBeNull();
  });

  it("refuses another user and burns the ticket", () => {
    const { tickets } = store();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(
      tickets.redeem({ userId: "user-2", sessionId: owner.sessionId, ticket: minted.ticket }),
    ).toBeNull();
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toBeNull();
  });

  it("refuses another session of the same user and burns the ticket", () => {
    const { tickets } = store();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(
      tickets.redeem({ userId: owner.userId, sessionId: "session-2", ticket: minted.ticket }),
    ).toBeNull();
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toBeNull();
  });

  it("refuses malformed tickets and forgets a revoked user's tickets", () => {
    const { tickets } = store();
    expect(tickets.redeem({ ...owner, ticket: "short" })).toBeNull();
    const minted = tickets.mint({ ...owner, nodeId: "node-1" });
    const kept = tickets.mint({ userId: "user-2", sessionId: "s", nodeId: "node-2" });
    tickets.revokeForUser(owner.userId);
    expect(tickets.redeem({ ...owner, ticket: minted.ticket })).toBeNull();
    expect(
      tickets.redeem({ userId: "user-2", sessionId: "s", ticket: kept.ticket }),
    ).not.toBeNull();
  });

  it("forgets tickets an admin minted while impersonating when that admin is revoked", () => {
    const { tickets } = store();
    const impersonated = tickets.mint({ ...owner, impersonatedBy: "admin-1", nodeId: "node-1" });
    const own = tickets.mint({ ...owner, nodeId: "node-1" });
    tickets.revokeForUser("admin-1");
    expect(tickets.redeem({ ...owner, ticket: impersonated.ticket })).toBeNull();
    expect(tickets.redeem({ ...owner, ticket: own.ticket })).not.toBeNull();
  });

  it("bounds a user's unredeemed tickets and prunes expired ones", () => {
    const { clock, tickets } = store();
    const first = tickets.mint({ ...owner, nodeId: "node-1" });
    for (let index = 1; index < TERMINAL_TICKETS_PER_USER; index += 1) {
      tickets.mint({ ...owner, nodeId: "node-1" });
    }
    expect(tickets.size).toBe(TERMINAL_TICKETS_PER_USER);
    const last = tickets.mint({ ...owner, nodeId: "node-1" });
    expect(tickets.size).toBe(TERMINAL_TICKETS_PER_USER);
    expect(tickets.redeem({ ...owner, ticket: first.ticket })).toBeNull();
    expect(tickets.redeem({ ...owner, ticket: last.ticket })).not.toBeNull();
    clock.now += TERMINAL_TICKET_TTL_MS;
    tickets.mint({ userId: "user-2", sessionId: "s", nodeId: "node-2" });
    expect(tickets.size).toBe(1);
  });
});
