import { describe, expect, it, vi } from "vitest";

import { deliverTerminalCopy, type TerminalCopyUi } from "./terminal-clipboard";

function ui(writeText: TerminalCopyUi["writeText"] = async () => undefined) {
  return {
    writeText: vi.fn(writeText),
    prompt: vi.fn(),
    copied: vi.fn(),
    tooLarge: vi.fn(),
  };
}

const text = { kind: "text", text: "hello" } as const;

describe("deliverTerminalCopy", () => {
  it("asks first in prompt mode without touching the clipboard", async () => {
    const calls = ui();
    await deliverTerminalCopy("prompt", text, calls);
    expect(calls.prompt).toHaveBeenCalledWith("hello");
    expect(calls.writeText).not.toHaveBeenCalled();
  });

  it("copies at once in auto mode", async () => {
    const calls = ui();
    await deliverTerminalCopy("auto", text, calls);
    expect(calls.writeText).toHaveBeenCalledWith("hello");
    expect(calls.copied).toHaveBeenCalled();
    expect(calls.prompt).not.toHaveBeenCalled();
  });

  it("falls back to the prompt when the browser refuses an auto copy", async () => {
    const calls = ui(async () => {
      throw new Error("NotAllowedError");
    });
    await deliverTerminalCopy("auto", text, calls);
    expect(calls.prompt).toHaveBeenCalledWith("hello");
    expect(calls.copied).not.toHaveBeenCalled();
  });

  it("does nothing when off, and reports oversize copies otherwise", async () => {
    const off = ui();
    await deliverTerminalCopy("off", { kind: "too_large" }, off);
    await deliverTerminalCopy("off", text, off);
    expect(Object.values(off).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    const on = ui();
    await deliverTerminalCopy("prompt", { kind: "too_large" }, on);
    expect(on.tooLarge).toHaveBeenCalled();
    expect(on.prompt).not.toHaveBeenCalled();
  });
});
