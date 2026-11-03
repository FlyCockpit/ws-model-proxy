import { describe, expect, it } from "vitest";
import {
  OPENING,
  type TabEvent,
  type TabStatus,
  tabApprovalCode,
  tabEnded,
  tabRejection,
  transitionTab,
} from "./terminal-tab-status";

const live: TabStatus = { phase: "live", inputDropped: false };
const rejected: TabStatus = { phase: "rejected", reason: "denied" };
const exited: TabStatus = { phase: "exited", cause: "exit", exitCode: 0, exitSignal: null };
const gone: TabStatus = { phase: "exited", cause: "gone" };
const awaitingApproval: TabStatus = { phase: "opening", approvalCode: "ABCD", reopen: null };

function run(status: TabStatus, ...events: TabEvent[]): TabStatus {
  return events.reduce(transitionTab, status);
}

describe("transitionTab", () => {
  it("goes opening -> approval -> live -> exited", () => {
    const approval = run(OPENING, { type: "approvalRequested", approvalCode: "ABCD" });
    expect(approval).toEqual(awaitingApproval);
    expect(tabApprovalCode(approval)).toBe("ABCD");
    const established = run(approval, { type: "established" });
    expect(established).toEqual(live);
    expect(tabApprovalCode(established)).toBeNull();
    expect(run(established, { type: "exited", exitCode: 3, exitSignal: null })).toEqual({
      phase: "exited",
      cause: "exit",
      exitCode: 3,
      exitSignal: null,
    });
  });

  it("drops an earlier attempt's approval code on retry", () => {
    const refused = run(awaitingApproval, { type: "refused", reason: "denied" });
    expect(refused).toEqual(rejected);
    expect(run(refused, { type: "retry" })).toEqual(OPENING);
    expect(run(awaitingApproval, { type: "retry" })).toEqual(OPENING);
  });

  it("ignores an approval request for a tab that is not opening", () => {
    for (const status of [live, rejected, exited, gone]) {
      expect(run(status, { type: "approvalRequested", approvalCode: "X" })).toBe(status);
    }
  });

  it("never brings an exited tab back", () => {
    const events: TabEvent[] = [
      { type: "retry" },
      { type: "acknowledged" },
      { type: "established" },
      { type: "refused", reason: "denied" },
      { type: "relayError", reason: "invalid" },
      { type: "detached", cause: "slow" },
      { type: "disconnected" },
      { type: "gone" },
      { type: "inputDropped" },
    ];
    for (const status of [exited, gone]) {
      for (const event of events) expect(run(status, event)).toBe(status);
    }
  });

  it("fills in how a gone terminal ended from a later exit", () => {
    expect(run(gone, { type: "exited", exitCode: null, exitSignal: "HUP" })).toEqual({
      phase: "exited",
      cause: "exit",
      exitCode: null,
      exitSignal: "HUP",
    });
    expect(run(exited, { type: "exited", exitCode: 9, exitSignal: null })).toBe(exited);
  });

  it("refuses an opening tab on a relay error, and leaves others alone", () => {
    expect(run(OPENING, { type: "relayError", reason: "limit" })).toEqual({
      phase: "rejected",
      reason: "limit",
    });
    expect(run(live, { type: "relayError", reason: "limit" })).toBe(live);
    expect(run(rejected, { type: "relayError", reason: "limit" })).toBe(rejected);
  });

  it("reopens a detached tab with its cause until the relay answers the next attach", () => {
    const slow = run(live, { type: "detached", cause: "slow" });
    expect(slow).toEqual({ phase: "opening", approvalCode: null, reopen: "slow" });
    expect(run(slow, { type: "acknowledged" })).toEqual(OPENING);
    expect(run(slow, { type: "established" })).toEqual(live);
    // A refused tab stays refused: nothing would attach it again.
    expect(run(rejected, { type: "detached", cause: "detached" })).toBe(rejected);
  });

  it("puts live and opening tabs back to opening on disconnect, clearing the approval code", () => {
    expect(run(live, { type: "disconnected" })).toEqual(OPENING);
    expect(run(awaitingApproval, { type: "disconnected" })).toEqual(OPENING);
    expect(run(rejected, { type: "disconnected" })).toBe(rejected);
  });

  it("shows dropped input on a live tab until it expires", () => {
    const dropped = run(live, { type: "inputDropped" });
    expect(dropped).toEqual({ phase: "live", inputDropped: true });
    expect(run(dropped, { type: "inputDropped" })).toBe(dropped);
    expect(run(dropped, { type: "inputDroppedExpired" })).toEqual(live);
    expect(run(OPENING, { type: "inputDropped" })).toBe(OPENING);
    // A notice from before a reattach does not survive it.
    expect(run(dropped, { type: "detached", cause: "slow" }, { type: "established" })).toEqual(
      live,
    );
  });

  it("returns the same object for events that change nothing", () => {
    expect(run(OPENING, { type: "retry" })).toBe(OPENING);
    expect(run(OPENING, { type: "acknowledged" })).toBe(OPENING);
    expect(run(live, { type: "established" })).toBe(live);
    expect(run(rejected, { type: "refused", reason: "denied" })).toBe(rejected);
  });

  it("answers the derived questions", () => {
    expect([OPENING, live, rejected, exited, gone].map(tabEnded)).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(tabRejection(rejected)).toBe("denied");
    expect(tabRejection(live)).toBeNull();
  });
});
