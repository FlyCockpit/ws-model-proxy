import { describe, expect, it } from "vitest";

import {
  applyTerminalModifiers,
  ctrlCharacter,
  encodeTerminalKey,
  stripPasteMarkers,
  terminalDataKey,
} from "./terminal-key-encoding";

describe("encodeTerminalKey", () => {
  it("sends plain keys as xterm does", () => {
    expect(encodeTerminalKey("Esc")).toBe("\x1b");
    expect(encodeTerminalKey("Tab")).toBe("\t");
    expect(encodeTerminalKey("Enter")).toBe("\r");
    expect(encodeTerminalKey("Backspace")).toBe("\x7f");
    expect(encodeTerminalKey("Space")).toBe(" ");
    expect(encodeTerminalKey("x")).toBe("x");
  });

  it("follows application cursor mode for unmodified arrows", () => {
    expect(encodeTerminalKey("Up")).toBe("\x1b[A");
    expect(encodeTerminalKey("Down")).toBe("\x1b[B");
    expect(encodeTerminalKey("Right")).toBe("\x1b[C");
    expect(encodeTerminalKey("Left")).toBe("\x1b[D");
    expect(encodeTerminalKey("Up", {}, { applicationCursor: true })).toBe("\x1bOA");
    expect(encodeTerminalKey("Left", {}, { applicationCursor: true })).toBe("\x1bOD");
    expect(encodeTerminalKey("Home", {}, { applicationCursor: true })).toBe("\x1bOH");
  });

  it("uses the CSI modifier parameter for modified arrows in either mode", () => {
    expect(encodeTerminalKey("Up", { ctrl: true })).toBe("\x1b[1;5A");
    expect(encodeTerminalKey("Left", { alt: true })).toBe("\x1b[1;3D");
    expect(encodeTerminalKey("Right", { ctrl: true, alt: true }, { applicationCursor: true })).toBe(
      "\x1b[1;7C",
    );
    expect(encodeTerminalKey("Down", { shift: true })).toBe("\x1b[1;2B");
  });

  it("encodes tilde keys with and without modifiers", () => {
    expect(encodeTerminalKey("Delete")).toBe("\x1b[3~");
    expect(encodeTerminalKey("PageUp", { ctrl: true })).toBe("\x1b[5;5~");
  });

  it("maps Ctrl to control characters", () => {
    expect(encodeTerminalKey("c", { ctrl: true })).toBe("\x03");
    expect(encodeTerminalKey("C", { ctrl: true })).toBe("\x03");
    expect(encodeTerminalKey("[", { ctrl: true })).toBe("\x1b");
    expect(encodeTerminalKey("\\", { ctrl: true })).toBe("\x1c");
    expect(encodeTerminalKey("_", { ctrl: true })).toBe("\x1f");
    expect(encodeTerminalKey("@", { ctrl: true })).toBe("\x00");
    expect(encodeTerminalKey("Space", { ctrl: true })).toBe("\x00");
    expect(encodeTerminalKey("Backspace", { ctrl: true })).toBe("\b");
    // No Ctrl form: the character goes as is.
    expect(encodeTerminalKey(".", { ctrl: true })).toBe(".");
    expect(ctrlCharacter("é")).toBeNull();
  });

  it("sends Alt as an ESC prefix", () => {
    expect(encodeTerminalKey("x", { alt: true })).toBe("\x1bx");
    expect(encodeTerminalKey("b", { alt: true })).toBe("\x1bb");
    expect(encodeTerminalKey(".", { alt: true })).toBe("\x1b.");
    expect(encodeTerminalKey("Esc", { alt: true })).toBe("\x1b\x1b");
    expect(encodeTerminalKey("Enter", { alt: true })).toBe("\x1b\r");
    expect(encodeTerminalKey("c", { ctrl: true, alt: true })).toBe("\x1b\x03");
  });

  it("sends Shift+Tab as back-tab and Shift/Ctrl+Enter as LF", () => {
    expect(encodeTerminalKey("Tab", { shift: true })).toBe("\x1b[Z");
    // As xterm.js: Alt adds no ESC to Tab.
    expect(encodeTerminalKey("Tab", { alt: true })).toBe("\t");
    expect(encodeTerminalKey("Tab", { alt: true, shift: true })).toBe("\x1b[Z");
    expect(applyTerminalModifiers("\t", { alt: true })).toBe("\t");
    expect(encodeTerminalKey("Enter", { shift: true })).toBe("\n");
    expect(encodeTerminalKey("Enter", { ctrl: true })).toBe("\n");
    expect(encodeTerminalKey("a", { shift: true })).toBe("A");
  });

  it("sends Ctrl+Enter as the terminal's Shift+Enter setting says", () => {
    expect(encodeTerminalKey("Enter", { ctrl: true }, { modifiedEnter: "\r" })).toBe("\r");
    expect(encodeTerminalKey("Enter", { ctrl: true }, { modifiedEnter: "\x1b\r" })).toBe("\x1b\r");
    expect(encodeTerminalKey("Enter", { ctrl: true, alt: true }, { modifiedEnter: "\n" })).toBe(
      "\x1b\r",
    );
  });
});

describe("terminalDataKey", () => {
  it("maps keyboard data back to its key", () => {
    expect(terminalDataKey("\r")).toBe("Enter");
    expect(terminalDataKey("\x7f")).toBe("Backspace");
    expect(terminalDataKey("\t")).toBe("Tab");
    expect(terminalDataKey("\x1b")).toBe("Esc");
    expect(terminalDataKey(" ")).toBe("Space");
    expect(terminalDataKey("\x1b[A")).toBe("Up");
    expect(terminalDataKey("\x1bOD")).toBe("Left");
    expect(terminalDataKey("\x1b[3~")).toBe("Delete");
    expect(terminalDataKey("q")).toBe("q");
    expect(terminalDataKey("😀")).toBe("😀");
  });

  it("returns null for data that is not one key", () => {
    expect(terminalDataKey("hello")).toBeNull();
    expect(terminalDataKey("\x1b[<0;3;4M")).toBeNull();
    expect(terminalDataKey("\x1b[1;5A")).toBeNull();
    expect(terminalDataKey("")).toBeNull();
  });
});

describe("applyTerminalModifiers", () => {
  it("applies latched modifiers to a received character", () => {
    expect(applyTerminalModifiers("c", { ctrl: true })).toBe("\x03");
    expect(applyTerminalModifiers("x", { alt: true })).toBe("\x1bx");
    expect(applyTerminalModifiers("\x1b[A", { ctrl: true })).toBe("\x1b[1;5A");
    expect(applyTerminalModifiers("\x1bOA", { alt: true }, { applicationCursor: true })).toBe(
      "\x1b[1;3A",
    );
    expect(applyTerminalModifiers("\r", { alt: true })).toBe("\x1b\r");
  });

  it("gives the modifier to the first character of an inserted word", () => {
    expect(applyTerminalModifiers("cat", { ctrl: true })).toBe("\x03at");
  });

  it("leaves data it cannot modify alone", () => {
    expect(applyTerminalModifiers("c", {})).toBeNull();
    expect(applyTerminalModifiers("\x1b[<0;3;4M", { ctrl: true })).toBeNull();
  });
});

describe("stripPasteMarkers", () => {
  it("removes bracketed-paste markers so a paste cannot end its bracket early", () => {
    expect(stripPasteMarkers("a\x1b[201~rm -rf ~\x1b[200~b")).toBe("arm -rf ~b");
    expect(stripPasteMarkers("x\x9b201~y")).toBe("xy");
    expect(stripPasteMarkers("plain\ntext")).toBe("plain\ntext");
  });

  it("never leaves a marker rebuilt from the pieces around a removed one", () => {
    expect(stripPasteMarkers("\x1b[20\x1b[201~1~echo unexpected\n")).toBe("echo unexpected\n");
    expect(stripPasteMarkers("\x1b[2\x1b[20\x1b[201~1~01~x")).toBe("x");
    expect(stripPasteMarkers("a\x9b20\x1b[200~1~b")).toBe("ab");
    expect(stripPasteMarkers("\x1b[2001~ \x1b[20~")).toBe("\x1b[2001~ \x1b[20~");
  });

  it("strips deeply nested markers in linear time", () => {
    const n = 100_000;
    const nested = `${"\x1b[20".repeat(n)}${"1~".repeat(n)}after`;
    const started = performance.now();
    expect(stripPasteMarkers(nested)).toBe("after");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
