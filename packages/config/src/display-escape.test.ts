import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISPLAY_ESCAPE_RANGES, escapeForDisplay, needsDisplayEscape } from "./display-escape";

type Shared = {
  ranges: [string, string][];
  vectors: { input: string; output: string }[];
};

const shared = JSON.parse(
  readFileSync(new URL("./display-escape-vectors.json", import.meta.url), "utf8"),
) as Shared;

describe("display escaping (shared with the CLI)", () => {
  it("uses exactly the shared code point list", () => {
    expect(
      DISPLAY_ESCAPE_RANGES.map(([start, end]) => [start.toString(16), end.toString(16)]),
    ).toEqual(
      shared.ranges.map(([start, end]) => [
        Number.parseInt(start, 16).toString(16),
        Number.parseInt(end, 16).toString(16),
      ]),
    );
    // Sorted and disjoint, which `needsDisplayEscape` relies on.
    for (let index = 1; index < DISPLAY_ESCAPE_RANGES.length; index += 1) {
      const previous = DISPLAY_ESCAPE_RANGES[index - 1];
      const current = DISPLAY_ESCAPE_RANGES[index];
      expect(previous && current && previous[1] < current[0]).toBe(true);
    }
  });

  it.each(shared.vectors)("escapes $input", ({ input, output }) => {
    expect(escapeForDisplay(input)).toBe(output);
  });

  it("covers every code point of every range and nothing next to them", () => {
    for (const [start, end] of DISPLAY_ESCAPE_RANGES) {
      expect(needsDisplayEscape(start)).toBe(true);
      expect(needsDisplayEscape(end)).toBe(true);
    }
    expect(needsDisplayEscape(0x0a)).toBe(false);
    expect(needsDisplayEscape(0x20)).toBe(false);
    expect(needsDisplayEscape(0x7e)).toBe(false);
    expect(needsDisplayEscape(0xe01f0)).toBe(false);
  });

  it("shows a lone surrogate instead of passing it through", () => {
    expect(escapeForDisplay("a\ud800b")).toBe("a\\u{d800}b");
  });
});
