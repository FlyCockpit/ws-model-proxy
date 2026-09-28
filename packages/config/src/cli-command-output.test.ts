import { describe, expect, it } from "vitest";
import {
  CLI_OUTPUT_ELLIPSIS,
  cleanText,
  formatBoundedStream,
  redactCredentialSubstrings,
} from "./cli-command-output";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("cleanText", () => {
  it("strips terminal sequences and controls and redacts product credentials", () => {
    expect(
      cleanText("\u001b[1;31mred\u001b[0m \u001b]0;title\u0007ok\u0000 key=wsmp_model_AbC-1_x\r\n"),
    ).toBe("red ok key=[redacted]\r\n");
    expect(cleanText("wsmp_cli_")).toBe("[redacted]");
    expect(cleanText("tab\tstays\u0085")).toBe("tab\tstays");
  });

  it.each([
    ["DCS", "\u001bP1$r0m\u001b\\"],
    ["APC", "\u001b_Gf=100;AAAA\u001b\\"],
    ["PM", "\u001b^private message\u001b\\"],
    ["SOS", "\u001bXstart of string\u001b\\"],
    ["DCS (8-bit)", "\u0090q#0;2;0;0;0\u009c"],
    ["APC (8-bit)", "\u009fGpayload\u009c"],
    ["PM (8-bit)", "\u009epm\u001b\\"],
    ["CSI (8-bit)", "\u009b2J"],
    ["OSC (8-bit)", "\u009d0;title\u0007"],
    ["charset designation", "\u001b(B"],
  ])("removes a whole %s sequence, payload included (f4-a)", (_label, sequence) => {
    expect(cleanText(`before${sequence}after`)).toBe("beforeafter");
  });

  it("does not end DCS/APC/PM at BEL; only ST ends them", () => {
    expect(cleanText("a\u001bPpayload\u0007still-payload\u001b\\b")).toBe("ab");
    expect(cleanText("a\u001b_x\u0007y\u009cb")).toBe("ab");
  });

  it.each([
    ["DCS", "\u001bPq#0;2;0;0;0#0~~"],
    ["APC", "\u001b_Gf=100;AAAA"],
    ["PM", "\u001b^secret"],
    ["DCS (8-bit)", "\u0090partial"],
    ["OSC", "\u001b]0;title"],
    ["CSI", "\u001b[1;3"],
    ["lone ESC", "\u001b"],
    ["ESC before the terminator", "\u001bPpayload\u001b"],
  ])("drops an unterminated %s at the end of the buffer", (_label, sequence) => {
    expect(cleanText(`kept${sequence}`)).toBe("kept");
  });

  it("resumes after an ESC that aborts a control string", () => {
    expect(cleanText("a\u001bPdcs\u001b[31mred\u001b[0m")).toBe("ared");
  });

  // Each pair was checked against xterm.js's EscapeSequenceParser (the web
  // terminal), which prints only "before" and "after" for all of them.
  it.each([
    ["CSI cancelled by a DCS", "\u001b[0\u001bPqHIDDEN\u001b\\"],
    ["CSI cancelled by an APC", "\u001b[0\u001b_HIDDEN\u001b\\"],
    ["CSI cancelled by an 8-bit APC", "\u001b[0\u009fHIDDEN\u009c"],
    ["ESC restarted into a PM", "\u001b\u001b^HIDDEN\u001b\\"],
    ["ESC intermediate cancelled by an APC", "\u001b(\u001b_HIDDEN\u001b\\"],
    ["CSI intermediate cancelled by a SOS", "\u001b[1 \u001bXHIDDEN\u001b\\"],
    ["OSC ended by a DCS", "\u001b]0;t\u001bPqHIDDEN\u001b\\"],
    ["DCS ended by an APC", "\u001bPq\u001b_HIDDEN\u001b\\"],
    ["CAN, then an APC", "\u001b[1\u0018\u001b_HIDDEN\u009c"],
  ])("follows the terminal when a sequence is cut short: %s", (_label, sequence) => {
    expect(cleanText(`before${sequence}after`)).toBe("beforeafter");
  });

  it("keeps consuming a control string past non-ASCII text, where xterm.js stops", () => {
    // xterm.js abandons an APC at "é" and prints " HIDDEN"; other terminals
    // consume to ST. Dropping it can only hide text, never show hidden text.
    expect(cleanText("before\u001b_é HIDDEN\u001b\\after")).toBe("beforeafter");
    expect(cleanText("before\u001bP1é HIDDEN\u001b\\after")).toBe("beforeafter");
  });

  it.each([
    ["ESC", "\u001b"],
    ["CSI", "\u001b[1"],
    ["charset escape", "\u001b("],
    ["8-bit CSI", "\u009b"],
  ])("drops a whole astral character that abandons a %s", (_label, sequence) => {
    // xterm.js drops the code point, never half of it.
    expect(cleanText(`ok ${sequence}😀 done`)).toBe("ok  done");
    expect(cleanText(`${sequence}😀`)).toBe("");
  });

  it("keeps astral characters in plain and styled text", () => {
    expect(cleanText("a😀b\u001b[31m😀\u001b[0m")).toBe("a😀b😀");
  });

  it("keeps the text after a sequence the terminal cancels", () => {
    // CAN and SUB end a sequence; the text after them prints.
    expect(cleanText("a\u001b[12\u0018shown")).toBe("ashown");
    expect(cleanText("a\u001b]0;t\u001ashown")).toBe("ashown");
    // A non-ASCII character abandons a CSI and is itself dropped.
    expect(cleanText("a\u001b[1éshown")).toBe("ashown");
    // LF inside a CSI is executed, so it survives.
    expect(cleanText("a\u001b[1\n2mb")).toBe("a\nb");
  });

  it("never lets a control string's payload through formatBoundedStream", () => {
    const head = bytes("ok \u001bP+q544e\u001b\\ \u001b_evil\u001b\\ \u001b^pm\u001b\\ done");
    const text = formatBoundedStream({
      head,
      tail: new Uint8Array(),
      totalBytes: head.length,
    }).text;
    expect(text).toBe("ok    done");
    expect(text).not.toMatch(/544e|evil|pm/);
  });

  it("redacts every product prefix anywhere in the text", () => {
    expect(
      redactCredentialSubstrings(
        "a wsmp_model_x b wsmp_cli_y c wsmp_device_z d wsmp_mcp_w e wsmp_other_v",
      ),
    ).toBe("a [redacted] b [redacted] c [redacted] d [redacted] e wsmp_other_v");
  });
});

describe("formatBoundedStream", () => {
  it("joins an overlapping head and tail without repeating bytes", () => {
    const text = "0123456789";
    const formatted = formatBoundedStream({
      head: bytes(text.slice(0, 6)),
      tail: bytes(text.slice(4)),
      totalBytes: 10,
    });
    expect(formatted).toEqual({ text, truncated: false, totalBytes: 10 });
  });

  it("marks a gap between head and tail with the ellipsis", () => {
    const formatted = formatBoundedStream({
      head: bytes("HEAD"),
      tail: bytes("TAIL"),
      totalBytes: 100,
    });
    expect(formatted).toEqual({
      text: `HEAD${CLI_OUTPUT_ELLIPSIS}`,
      truncated: true,
      totalBytes: 100,
    });
  });

  it("keeps a tail that starts mid-token free of the partial token", () => {
    const formatted = formatBoundedStream({
      head: bytes("start "),
      tail: bytes("model_secretpart visible"),
      totalBytes: 1000,
    });
    expect(formatted.text).toBe(`start ${CLI_OUTPUT_ELLIPSIS} visible`);
  });

  it("is empty for an empty stream", () => {
    expect(
      formatBoundedStream({ head: new Uint8Array(), tail: new Uint8Array(), totalBytes: 0 }),
    ).toEqual({ text: "", truncated: false, totalBytes: 0 });
  });
});
