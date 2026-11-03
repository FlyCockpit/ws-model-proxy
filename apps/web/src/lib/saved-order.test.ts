import { describe, expect, it } from "vitest";

import { applySavedOrder, moveItem, nextSavedOrder, SAVED_ORDER_MAX } from "./saved-order";

type Item = { id: string | null; name: string };
const item = (id: string | null, name = id ?? "opening"): Item => ({ id, name });
const idOf = (entry: Item) => entry.id;

describe("applySavedOrder", () => {
  it("puts saved ids first in the saved order, then the rest as they came", () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    expect(applySavedOrder(items, idOf, ["c", "a"]).map(idOf)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores saved ids that are gone and keeps items without an id at the end", () => {
    const items = [item(null, "new"), item("b"), item("a")];
    expect(applySavedOrder(items, idOf, ["gone", "a", "b"]).map((entry) => entry.name)).toEqual([
      "a",
      "b",
      "new",
    ]);
  });

  it("returns the items unchanged without a saved order", () => {
    const items = [item("b"), item("a")];
    const ordered = applySavedOrder(items, idOf, []);
    expect(ordered).toEqual(items);
    expect(ordered).not.toBe(items);
  });

  it("uses the first place of a repeated saved id", () => {
    expect(applySavedOrder([item("a"), item("b")], idOf, ["b", "a", "b"]).map(idOf)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("moveItem", () => {
  it("moves an item forward and back", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps the target and ignores a missing source", () => {
    expect(moveItem(["a", "b", "c"], 1, 9)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 1, -4)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});

describe("nextSavedOrder", () => {
  it("saves the shown order, then keeps saved ids that are not shown", () => {
    expect(nextSavedOrder(["b", null, "a"], ["a", "offline", "b"])).toEqual(["b", "a", "offline"]);
  });

  it("drops ids the server would refuse and stops at the limit", () => {
    expect(nextSavedOrder(["ok", "has space", ""], [])).toEqual(["ok"]);
    const many = Array.from({ length: SAVED_ORDER_MAX + 5 }, (_, index) => `t${index}`);
    expect(nextSavedOrder(many, ["extra"])).toHaveLength(SAVED_ORDER_MAX);
  });
});
