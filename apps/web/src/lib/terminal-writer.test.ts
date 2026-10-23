import { describe, expect, it } from "vitest";

import {
  canSendResize,
  classifyBroadcastEpoch,
  floorTerminalSize,
  followSize,
  isAutomaticReply,
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
  it("follows only when this tab is not the writer", () => {
    expect(isFollowing({ writer: "other" })).toBe(true);
    expect(isFollowing({ writer: "none" })).toBe(true);
    expect(isFollowing({ writer: "you" })).toBe(false);
  });

  it("sends resizes only as the writer and takes over otherwise", () => {
    expect(canSendResize({ writer: "you" })).toBe(true);
    expect(canSendResize({ writer: "other" })).toBe(false);
    expect(needsTakeover({ writer: "none" })).toBe(true);
    expect(needsTakeover({ writer: "you" })).toBe(false);
  });

  it("follows the PTY size only once it is known", () => {
    const base = { writer: "other" as const };
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

  it("never takes a follower's automatic reply as input, even right after a keypress", () => {
    const replies = [
      "\x1b[12;1R", // CPR
      "\x1b[?12;1R", // DECXCPR
      "\x1b[0n", // DSR status
      "\x1b[?1;2c", // DA1
      "\x1b[>0;276;0c", // DA2
      "\x1b[?2004;2$y", // DECRPM
      "\x1b[8;24;80t", // XTWINOPS size report
      "\x1bP1$r0m\x1b\\", // DECRQSS
      "\x1bP>|xterm.js(5.5.0)\x1b\\", // XTVERSION
      "\x1b]11;rgb:0000/0000/0000\x1b\\", // OSC 11 color reply
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
    ];
    for (const data of replies) {
      expect(isAutomaticReply(data)).toBe(true);
      expect(shouldForwardTerminalData({ following: true, userInput: true, data })).toBe(false);
    }
  });

  it("does not mistake keys or mouse reports for replies", () => {
    const input = [
      "a",
      "\r",
      "\x1b[A", // Up
      "\x1b[1;5C", // Ctrl+Right
      "\x1b[3~", // Delete
      "\x1bOP", // F1
      "\x1b[15;2~", // Shift+F5
      "\x1b[<0;10;5M", // SGR mouse press
      "\x1b[<0;10;5m", // SGR mouse release
      "\x1b[200~pasted\x1b[201~", // bracketed paste
    ];
    for (const data of input) {
      expect(isAutomaticReply(data)).toBe(false);
      expect(shouldForwardTerminalData({ following: true, userInput: true, data })).toBe(true);
    }
  });

  it("forgets earlier input when disarmed", () => {
    const gate = new TerminalUserInputGate(500);
    gate.arm(1_000);
    gate.disarm();
    expect(gate.armed(1_100)).toBe(false);
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

describe("floorTerminalSize", () => {
  it("keeps a squeezed pane from shrinking the PTY below 20x5", () => {
    expect(floorTerminalSize({ cols: 4, rows: 2 })).toEqual({ cols: 20, rows: 5 });
    expect(floorTerminalSize({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
  });
});
