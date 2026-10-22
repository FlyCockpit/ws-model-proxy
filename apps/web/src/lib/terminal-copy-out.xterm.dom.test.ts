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
