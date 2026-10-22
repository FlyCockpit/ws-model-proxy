// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  CopyOutGate,
  decodeOsc52Text,
  ReplayCopyTracker,
  TERMINAL_COPY_OUT_MAX_BYTES,
  wireTerminalCopyOut,
} from "./terminal-copy-out";

const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("terminal copy-out", () => {
  it("does not arm OSC 52 from terminal data", () => {
    const gate = new CopyOutGate();
    const received: string[] = [];
    let onData: ((data: string) => void) | undefined;
    const textarea = new EventTarget();
    wireTerminalCopyOut(
      {
        onData(callback) {
          onData = callback;
          return { dispose() {} };
        },
        parser: { registerOscHandler() {} },
        textarea,
      },
      gate,
      (data) => received.push(data),
    );
    onData?.("\u001b[6n");
    expect(received).toEqual(["\u001b[6n"]);
    expect(gate.allowed(true, Date.now())).toBe(false);
    textarea.dispatchEvent(new Event("keydown"));
    expect(gate.allowed(true, Date.now())).toBe(true);
  });

  it("hands allowed copies to onCopy and drops them while the gate is closed", () => {
    const gate = new CopyOutGate();
    const copies: unknown[] = [];
    let osc: ((data: string) => boolean) | undefined;
    wireTerminalCopyOut(
      {
        onData: () => ({ dispose() {} }),
        parser: {
          registerOscHandler(_id, handler) {
            osc = handler;
          },
        },
        textarea: null,
      },
      gate,
      () => undefined,
      (copy) => copies.push(copy),
    );
    const hasFocus = document.hasFocus;
    document.hasFocus = () => true;
    try {
      expect(osc?.(`c;${encode("before")}`)).toBe(true);
      expect(copies).toEqual([]);
      gate.armFromUserGesture();
      osc?.(`c;${encode("after")}`);
      expect(copies).toEqual([{ kind: "text", text: "after" }]);
      gate.disarm();
      osc?.(`c;${encode("replayed")}`);
      expect(copies).toHaveLength(1);
    } finally {
      document.hasFocus = hasFocus;
    }
  });

  it("stays closed while replay chunks are unparsed, whatever the gestures", () => {
    const gate = new CopyOutGate();
    gate.beginReplayChunk();
    gate.beginReplayChunk();
    gate.armFromUserGesture();
    expect(gate.allowed(true)).toBe(false);
    gate.endReplayChunk();
    expect(gate.allowed(true)).toBe(false);
    gate.endReplayChunk();
    expect(gate.allowed(true)).toBe(true);
    gate.beginReplayChunk();
    gate.clearReplay();
    expect(gate.allowed(true)).toBe(true);
  });

  it.each([
    ["plain text", "done", false],
    ["a finished copy", "\x1b]52;c;QQ==\x07", false],
    ["an open copy", "\x1b]52;c;QQ", true],
    ["an open OSC number that may become 52", "\x1b]5", true],
    ["an empty OSC number", "\x1b]", true],
    ["an open OSC 8 link", "\x1b]8;;https://example.com", false],
    ["an OSC number that can no longer be 52", "\x1b]53", false],
    ["an OSC 52 aborted by CAN", "\x1b]52;c;QQ\x18", false],
    ["an OSC 52 ended by ESC", "\x1b]52;c;QQ\x1b\\", false],
    ["an OSC 52 ended by a UTF-8 C1 string terminator", "\x1b]52;c;QQ\xc2\x9c", false],
    ["an open color sequence", "\x1b[31", false],
    // Not yet any sequence: treating them as copies would break colors and characters split
    // there. A copy whose introducer arrives live is a copy made now, not a stale one.
    ["a lone ESC", "\x1b", false],
    ["a UTF-8 C1 lead byte", "\xc2", false],
    ["an open C1 OSC 52", "\xc2\x9d52;c;", true],
  ])("tells whether replay ending in %s may leave a copy open", (_label, text, open) => {
    const tracker = new ReplayCopyTracker();
    tracker.feed(Uint8Array.from(text, (char) => char.charCodeAt(0)));
    expect(tracker.copyMayBeOpen()).toBe(open);
  });

  it("decodes UTF-8 text with or without padding", () => {
    expect(decodeOsc52Text(`c;${encode("héllo ✓")}`)).toEqual({ kind: "text", text: "héllo ✓" });
    expect(decodeOsc52Text(`;${encode("ab").replace(/=+$/, "")}`)).toEqual({
      kind: "text",
      text: "ab",
    });
  });

  it("never answers a clipboard read and ignores clears and junk", () => {
    expect(decodeOsc52Text("c;?")).toBeNull();
    expect(decodeOsc52Text("c;")).toBeNull();
    expect(decodeOsc52Text("c;not base64!")).toBeNull();
    expect(decodeOsc52Text("c;A")).toBeNull();
    // Not valid UTF-8.
    expect(decodeOsc52Text(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });

  it("reports text over the cap as too large", () => {
    const big = "A".repeat(Math.ceil(((TERMINAL_COPY_OUT_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    expect(decodeOsc52Text(`c;${big}`)).toEqual({ kind: "too_large" });
  });
});
