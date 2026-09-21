import { describe, expect, it } from "vitest";

import {
  isPrismaDecimalLike,
  MAX_JSON_SAFE_DEPTH,
  MCP_BYTES_ELIDED,
  MCP_FUNCTION_ELIDED,
  MCP_MAX_DEPTH_ELIDED,
  toJsonSafe,
} from "./serialization";

/** A decimal.js-shaped value (Prisma Decimal), built structurally. */
function decimalLike(value: string) {
  // decimal.js stores d (digits), s (sign), e (exponent) and exposes the
  // formatting methods the structural detector requires.
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const d = [...digits].map((char) => Number(char));
  return {
    d,
    e: digits.length - 1,
    s: negative ? -1 : 1,
    toString() {
      return value;
    },
    toFixed() {
      return value;
    },
    toSignificantDigits() {
      return { toString: () => value };
    },
  };
}

describe("toJsonSafe — Phase 5 conversion matrix", () => {
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

  it("converts Prisma Decimal values (decimal.js shape) to their decimal string", () => {
    const decimal = decimalLike("12.345");
    expect(isPrismaDecimalLike(decimal)).toBe(true);
    expect(toJsonSafe({ unitCost: decimal, list: [decimalLike("-0.5")] })).toEqual({
      unitCost: "12.345",
      list: ["-0.5"],
    });
  });

  it("does NOT mistake plain rows or arrays for Decimal values", () => {
    expect(isPrismaDecimalLike({ d: [1], e: 2, s: 3 })).toBe(false);
    expect(isPrismaDecimalLike([1, 2, 3])).toBe(false);
    expect(isPrismaDecimalLike({ e: 1, s: 1, toFixed: () => "1" })).toBe(false);
    expect(isPrismaDecimalLike(null)).toBe(false);
  });

  it("elides byte containers instead of encoding their contents", () => {
    const bytes = new Uint8Array([1, 2, 3, 0xff]);
    expect(toJsonSafe({ payload: bytes })).toEqual({ payload: MCP_BYTES_ELIDED });
    // Buffer is a Uint8Array subclass — same arm.
    expect(toJsonSafe({ buf: Buffer.from("secret-bytes") })).toEqual({
      buf: MCP_BYTES_ELIDED,
    });
  });

  it("elides functions (closures capture server scope)", () => {
    expect(toJsonSafe({ cb: () => "nope", keep: 1 })).toEqual({
      cb: MCP_FUNCTION_ELIDED,
      keep: 1,
    });
  });

  it("maps undefined to null and leaves arrays/scalars intact", () => {
    expect(toJsonSafe({ missing: undefined, arr: [1, "two", null], flag: false })).toEqual({
      missing: null,
      arr: [1, "two", null],
      flag: false,
    });
  });

  it("bounds recursion depth so cyclic structures cannot exhaust the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const converted = toJsonSafe(cyclic) as Record<string, unknown>;
    // Walking the converted cycle must hit the elision marker within the
    // depth bound (the cycle is infinite; conversion is not).
    let cursor: unknown = converted;
    let marker: unknown;
    for (let step = 0; step < MAX_JSON_SAFE_DEPTH + 4; step += 1) {
      const record = cursor as Record<string, unknown>;
      if (record.self === MCP_MAX_DEPTH_ELIDED) {
        marker = record.self;
        break;
      }
      cursor = record.self;
    }
    expect(marker).toBe(MCP_MAX_DEPTH_ELIDED);
    expect(() => JSON.stringify(converted)).not.toThrow();
  });

  it("never throws on JSON.stringify of any converted output", () => {
    const output = toJsonSafe({
      a: new Date(),
      b: 1n,
      c: new Uint8Array(4),
      d: decimalLike("9.99"),
      e: () => 1,
      f: [{ g: new Date("2026-05-05T00:00:00Z") }],
    });
    expect(() => JSON.stringify(output)).not.toThrow();
    expect(JSON.stringify(output)).toContain("2026-05-05T00:00:00.000Z");
  });
});
