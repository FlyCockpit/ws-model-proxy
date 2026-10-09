import { describe, expect, it } from "vitest";

import { collapseUnchanged, diffLines, stableJsonLines } from "./line-diff";

describe("line diff", () => {
  it("lists removed, added and unchanged lines in order", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "x" },
      { kind: "same", text: "c" },
      { kind: "add", text: "d" },
    ]);
    expect(diffLines([], ["a"])).toEqual([{ kind: "add", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ kind: "remove", text: "a" }]);
  });

  it("collapses long unchanged runs around changes", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) => (index === 10 ? "changed" : line));
    const hunks = collapseUnchanged(diffLines(before, after), 2);
    expect(hunks[0]).toEqual({ kind: "skip", count: 8 });
    expect(hunks.filter((line) => line.kind === "same")).toHaveLength(4);
    expect(hunks.at(-1)).toEqual({ kind: "skip", count: 7 });
  });

  it("ignores key order", () => {
    expect(stableJsonLines({ b: 1, a: { d: 2, c: 3 } })).toEqual(
      stableJsonLines({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
