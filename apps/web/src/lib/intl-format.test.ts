import { describe, expect, it } from "vitest";

import { COMPACT_COUNT, dateTimeFormat, numberFormat, relativeTimeFormat } from "./intl-format";

describe("intl-format", () => {
  it("returns one instance per kind, locale and options", () => {
    expect(numberFormat("en-US", COMPACT_COUNT)).toBe(numberFormat("en-US", COMPACT_COUNT));
    expect(numberFormat("en-US")).not.toBe(numberFormat("en-US", COMPACT_COUNT));
    expect(numberFormat("es-MX")).not.toBe(numberFormat("en-US"));
    expect(dateTimeFormat("en-US", { month: "short" })).toBe(
      dateTimeFormat("en-US", { month: "short" }),
    );
    expect(relativeTimeFormat("en-US", { numeric: "auto" })).toBe(
      relativeTimeFormat("en-US", { numeric: "auto" }),
    );
  });

  it("formats like a new formatter with the same options", () => {
    expect(numberFormat("en-US", COMPACT_COUNT).format(1234)).toBe("1.2K");
    expect(relativeTimeFormat("en-US", { numeric: "auto" }).format(-1, "day")).toBe("yesterday");
  });
});
