// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  CopyOutGate,
  decodeOsc52Text,
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
