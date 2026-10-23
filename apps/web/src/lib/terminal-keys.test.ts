import { describe, expect, it } from "vitest";

import { newlineSequence, type TerminalKeyEvent } from "./terminal-keys";

const key = (overrides: Partial<TerminalKeyEvent>): TerminalKeyEvent => ({
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides,
});

describe("newlineSequence", () => {
  it("maps Shift+Enter and Ctrl+Enter per mode", () => {
    expect(newlineSequence("lf", key({ shiftKey: true }))).toBe("\n");
    expect(newlineSequence("lf", key({ ctrlKey: true }))).toBe("\n");
    expect(newlineSequence("esc-cr", key({ shiftKey: true }))).toBe("\u001b\r");
    expect(newlineSequence("off", key({ shiftKey: true }))).toBeNull();
  });

  it("leaves Enter, other modifiers, other keys and IME composition to xterm", () => {
    expect(newlineSequence("lf", key({}))).toBeNull();
    expect(newlineSequence("lf", key({ shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(newlineSequence("lf", key({ shiftKey: true, altKey: true }))).toBeNull();
    expect(newlineSequence("lf", key({ shiftKey: true, metaKey: true }))).toBeNull();
    expect(newlineSequence("lf", key({ altKey: true }))).toBeNull();
    expect(newlineSequence("lf", key({ key: "a", shiftKey: true }))).toBeNull();
    expect(newlineSequence("lf", key({ shiftKey: true, isComposing: true }))).toBeNull();
  });
});
