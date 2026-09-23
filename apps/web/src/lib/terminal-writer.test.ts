import { describe, expect, it } from "vitest";

import {
  canSendResize,
  classifyBroadcastEpoch,
  followSize,
  isFollowing,
  needsTakeover,
  nextReattach,
  reattachDelayMs,
  shouldForwardTerminalData,
  TERMINAL_REATTACH_RESET_MS,
  TerminalUserInputGate,
  writerStatusKey,
} from "./terminal-writer";

describe("writer state", () => {
  it("follows only on a multi-viewer terminal when this tab is not the writer", () => {
    expect(isFollowing({ multiViewer: true, writer: "other" })).toBe(true);
    expect(isFollowing({ multiViewer: true, writer: "none" })).toBe(true);
    expect(isFollowing({ multiViewer: true, writer: "you" })).toBe(false);
    // A 2.4 terminal has one viewer, which is always the writer.
    expect(isFollowing({ multiViewer: false, writer: "other" })).toBe(false);
  });

  it("sends resizes only as the writer and takes over otherwise", () => {
    expect(canSendResize({ multiViewer: true, writer: "you" })).toBe(true);
    expect(canSendResize({ multiViewer: true, writer: "other" })).toBe(false);
    expect(needsTakeover({ multiViewer: true, writer: "none" })).toBe(true);
    expect(needsTakeover({ multiViewer: false, writer: "you" })).toBe(false);
  });

  it("follows the PTY size only once it is known", () => {
    const base = { multiViewer: true, writer: "other" as const };
    expect(followSize({ ...base, ptyCols: null, ptyRows: null })).toBeNull();
    expect(followSize({ ...base, ptyCols: 120, ptyRows: 40 })).toEqual({ cols: 120, rows: 40 });
    expect(followSize({ ...base, writer: "you", ptyCols: 120, ptyRows: 40 })).toBeNull();
  });

  it("maps the writer label to a status key", () => {
    expect(writerStatusKey("you")).toBe("dashboard:terminals.status.youTyping");
    expect(writerStatusKey("other")).toBe("dashboard:terminals.status.otherTyping");
    expect(writerStatusKey("none")).toBeNull();
  });
});

describe("automatic replies", () => {
  it("forwards everything from the writer", () => {
    expect(shouldForwardTerminalData({ following: false, userInput: false, data: "\x1b[I" })).toBe(
      true,
    );
    expect(
      shouldForwardTerminalData({ following: false, userInput: false, data: "\x1b[12;1R" }),
    ).toBe(true);
  });

  it("drops a follower's CPR, DA and focus replies without user input", () => {
    for (const data of ["\x1b[12;1R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[I", "\x1b[O"]) {
      expect(shouldForwardTerminalData({ following: true, userInput: false, data })).toBe(false);
    }
  });

  it("forwards a follower's typed data, but never a bare focus report", () => {
    expect(shouldForwardTerminalData({ following: true, userInput: true, data: "a" })).toBe(true);
    expect(shouldForwardTerminalData({ following: true, userInput: true, data: "\x1b[O" })).toBe(
      false,
    );
  });

  it("arms the input gate for a short window", () => {
    const gate = new TerminalUserInputGate(500);
    expect(gate.armed(0)).toBe(false);
    gate.arm(1_000);
    expect(gate.armed(1_000)).toBe(true);
    expect(gate.armed(1_500)).toBe(true);
    expect(gate.armed(1_501)).toBe(false);
    expect(gate.armed(999)).toBe(false);
  });
});

describe("broadcast epochs", () => {
  it("queues an unknown epoch, opens the current one and drops an old one", () => {
    expect(classifyBroadcastEpoch(null, 1)).toBe("queue");
    expect(classifyBroadcastEpoch(1, 2)).toBe("queue");
    expect(classifyBroadcastEpoch(2, 2)).toBe("open");
    expect(classifyBroadcastEpoch(3, 2)).toBe("drop");
  });
});

describe("slow reattach", () => {
  it("backs off and caps the delay", () => {
    expect(reattachDelayMs(0)).toBe(500);
    expect(reattachDelayMs(1)).toBe(1_000);
    expect(reattachDelayMs(10)).toBe(15_000);
  });

  it("starts over after a quiet period", () => {
    const first = nextReattach(undefined, 0);
    expect(first).toEqual({ delayMs: 500, state: { attempt: 0, lastAt: 0 } });
    const second = nextReattach(first.state, 1_000);
    expect(second.delayMs).toBe(1_000);
    const later = nextReattach(second.state, 1_000 + TERMINAL_REATTACH_RESET_MS);
    expect(later.state.attempt).toBe(0);
  });
});
