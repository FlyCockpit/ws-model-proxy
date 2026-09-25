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
