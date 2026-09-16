import { describe, expect, it } from "vitest";

import { toJsonSafe } from "./serialization";

/** Phase 4 seam: the structural conversions Phase 5 projectors rely on. */
describe("toJsonSafe", () => {
  it("serializes Date as ISO string and bigint as decimal string, recursively", () => {
    const input = {
      createdAt: new Date("2026-01-15T12:00:00Z"),
      count: 123n,
      nested: [{ big: 42n, when: new Date("2026-02-01T00:00:00Z") }],
      scalar: "text",
      n: 7,
      ok: true,
      nil: null,
    };
    expect(toJsonSafe(input)).toEqual({
      createdAt: "2026-01-15T12:00:00.000Z",
      count: "123",
      nested: [{ big: "42", when: "2026-02-01T00:00:00.000Z" }],
      scalar: "text",
      n: 7,
      ok: true,
      nil: null,
    });
  });

  it("JSON.stringify of the output never throws on Date/bigint inputs", () => {
    const output = toJsonSafe({ a: new Date(), b: 1n });
    expect(() => JSON.stringify(output)).not.toThrow();
  });
});
