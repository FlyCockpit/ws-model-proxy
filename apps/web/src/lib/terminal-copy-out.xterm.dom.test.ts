// @vitest-environment jsdom

import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CopyOutGate,
  createReplayAwareWriter,
  type Osc52Copy,
  wireTerminalCopyOut,
} from "./terminal-copy-out";

const bytes = (text: string) => new TextEncoder().encode(text);
const encode = (text: string) => btoa(String.fromCharCode(...bytes(text)));

/** Resolves once xterm has parsed everything written so far. */
const parsed = (term: Terminal) => new Promise<void>((resolve) => term.write("", resolve));

/** The real xterm parser, not a mock: OSC sequences can span writes. */
describe("replay-aware writes with the real xterm parser", () => {
  let hasFocus: typeof document.hasFocus;
  beforeEach(() => {
    hasFocus = document.hasFocus;
    document.hasFocus = () => true;
  });
  afterEach(() => {
    document.hasFocus = hasFocus;
  });

  function setup() {
    const term = new Terminal({ allowProposedApi: true });
    const gate = new CopyOutGate();
    const copies: Osc52Copy[] = [];
    wireTerminalCopyOut(
      term,
      gate,
      () => undefined,
      (copy) => copies.push(copy),
    );
    const writer = createReplayAwareWriter(term, gate);
    return { term, gate, copies, writer };
  }

  it("never completes an OSC 52 copy that the replay left open", async () => {
    const { term, gate, copies, writer } = setup();
    writer.write(bytes(`old output\x1b]52;c;${encode("replayed secret")}`), true);
    await parsed(term);
    gate.armFromUserGesture();
    writer.write(bytes("\x07live prompt$ "));
    await parsed(term);
    expect(copies).toEqual([]);
    term.dispose();
  });

  it("still honors a copy sent entirely in live output after the replay", async () => {
    const { term, gate, copies, writer } = setup();
    writer.write(bytes("old output"), true);
    await parsed(term);
    gate.armFromUserGesture();
    writer.write(bytes(`\x1b]52;c;${encode("fresh")}\x07`));
    await parsed(term);
    expect(copies).toEqual([{ kind: "text", text: "fresh" }]);
    term.dispose();
  });

  it.each([
    ["inside the OSC number", "\x1b]5", `2;c;${encode("secret")}\x07`],
    ["after the OSC number", "\x1b]52", `;c;${encode("secret")}\x07`],
    ["inside the payload", `\x1b]52;c;${encode("sec")}`, `${encode("ret")}\x07`],
    ["with leading zeros", "\x1b]0052;c;", `${encode("secret")}\x07`],
    ["after a C1 OSC", "\xc2\x9d52", `;c;${encode("secret")}\x07`],
  ])("blocks a copy cut %s at the end of the replay", async (_cut, replayed, live) => {
    const { term, gate, copies, writer } = setup();
    const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    writer.write(latin1(`old output${replayed}`), true);
    await parsed(term);
    gate.armFromUserGesture();
    writer.write(latin1(live));
    await parsed(term);
    expect(copies).toEqual([]);
    term.dispose();
  });

  it("keeps a color sequence split across the replay and live output", async () => {
    const { term, writer } = setup();
    writer.write(bytes("\x1b[31"), true);
    await parsed(term);
    writer.write(bytes("mred"));
    await parsed(term);
    const line = term.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe("red");
    expect(line?.getCell(0)?.isFgPalette()).toBe(true);
    expect(line?.getCell(0)?.getFgColor()).toBe(1);
    term.dispose();
  });

  it("keeps a color sequence split right after its ESC", async () => {
    const { term, writer } = setup();
    writer.write(bytes("\x1b"), true);
    await parsed(term);
    writer.write(bytes("[31mred"));
    await parsed(term);
    const line = term.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe("red");
    expect(line?.getCell(0)?.getFgColor()).toBe(1);
    term.dispose();
  });

  it("keeps a UTF-8 character split across the replay and live output", async () => {
    const { term, writer } = setup();
    writer.write(Uint8Array.of(0xc2), true);
    await parsed(term);
    writer.write(Uint8Array.of(0xa3));
    await parsed(term);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("£");
    term.dispose();
  });

  it("drops output queued before a reset, and its open copy, with the screen", async () => {
    const { term, gate, copies, writer } = setup();
    // The previous attach left an open copy and more output queued, unparsed.
    writer.write(bytes(`old\x1b]52;c;${encode("sec")}`));
    writer.reset();
    writer.write(bytes(`${encode("ret")}`), true);
    gate.armFromUserGesture();
    writer.write(bytes("\x07live"));
    await parsed(term);
    expect(copies).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).not.toContain("old");
    term.dispose();
  });

  it.each([
    ["a title", "0;normal title\x07hello", "hello"],
    ["an OSC 8 link", "8;;https://example.com\x07link\x1b]8;;\x07", "link"],
  ])("renders %s split right after its ESC ] unchanged", async (_label, live, shown) => {
    const { term, writer } = setup();
    writer.write(bytes("\x1b]"), true);
    await parsed(term);
    writer.write(bytes(live));
    await parsed(term);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(shown);
    term.dispose();
  });

  it("suppresses only the replay's open copy, not a fresh one in the same live write", async () => {
    const { term, gate, copies, writer } = setup();
    writer.write(bytes(`\x1b]52;c;${encode("sec")}`), true);
    await parsed(term);
    gate.armFromUserGesture();
    writer.write(bytes(`${encode("ret")}\x07\x1b]52;c;${encode("fresh")}\x07`));
    await parsed(term);
    expect(copies).toEqual([{ kind: "text", text: "fresh" }]);
    term.dispose();
  });

  it("ends suppression at a C1 string terminator, so a later fresh copy still works", async () => {
    const { term, gate, copies, writer } = setup();
    writer.write(bytes(`\x1b]52;c;${encode("sec")}`), true);
    await parsed(term);
    gate.armFromUserGesture();
    const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
    writer.write(latin1(`${encode("ret")}\xc2\x9c`));
    // A fresh copy introduced by C1 OSC, with no ESC that would end tracking anyway.
    writer.write(latin1(`\xc2\x9d52;c;${encode("fresh")}\x07`));
    await parsed(term);
    expect(copies).toEqual([{ kind: "text", text: "fresh" }]);
    term.dispose();
  });

  it("follows a replay's open copy across several live writes", async () => {
    const { term, gate, copies, writer } = setup();
    writer.write(bytes(`\x1b]52;c;${encode("a")}`), true);
    await parsed(term);
    gate.armFromUserGesture();
    writer.write(bytes("QUFB"));
    writer.write(bytes("QUFB\x07after"));
    await parsed(term);
    expect(copies).toEqual([]);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("after");
    term.dispose();
  });

  it("keeps an OSC 8 link split across the replay and live output", async () => {
    const { term, writer } = setup();
    writer.write(bytes("\x1b]8;;https://exa"), true);
    await parsed(term);
    writer.write(bytes("mple.com\x07link\x1b]8;;\x07"));
    await parsed(term);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("link");
    term.dispose();
  });

  it("lets live output complete a copy split across live writes", async () => {
    const { term, gate, copies, writer } = setup();
    gate.armFromUserGesture();
    writer.write(bytes(`\x1b]52;c;${encode("split")}`));
    writer.write(bytes("\x07"));
    await parsed(term);
    expect(copies).toEqual([{ kind: "text", text: "split" }]);
    term.dispose();
  });
});
