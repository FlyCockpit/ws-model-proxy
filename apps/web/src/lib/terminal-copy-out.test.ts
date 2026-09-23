import { describe, expect, it } from "vitest";

import { CopyOutGate, wireTerminalCopyOut } from "./terminal-copy-out";

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
});
