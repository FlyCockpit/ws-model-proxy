import { describe, expect, it } from "vitest";
import { localeNumberParts, parseLocaleDecimal } from "./decimal-input";

describe("localeNumberParts", () => {
  it("uses a dot decimal and comma grouping for both shipped locales", () => {
    expect(localeNumberParts("en-US")).toEqual({ decimal: ".", grouping: "," });
    expect(localeNumberParts("es-MX")).toEqual({ decimal: ".", grouping: "," });
  });

  it("uses a comma decimal and dot grouping in de-DE", () => {
    expect(localeNumberParts("de-DE")).toEqual({ decimal: ",", grouping: "." });
  });
});

describe("parseLocaleDecimal", () => {
  it.each(["en-US", "es-MX"] as const)(
    "accepts a %s dot decimal and rejects grouping",
    (locale) => {
      expect(parseLocaleDecimal("1.5", locale)).toBe("1.5");
      expect(parseLocaleDecimal(" 1500.5 ", locale)).toBe("1500.5");
      expect(parseLocaleDecimal(".5", locale)).toBe(".5");
      expect(parseLocaleDecimal("1.", locale)).toBe("1.");
      expect(parseLocaleDecimal("", locale)).toBe("");
      expect(parseLocaleDecimal("   ", locale)).toBe("");
      expect(parseLocaleDecimal("1,500", locale)).toBeNull();
      expect(parseLocaleDecimal("25,5", locale)).toBeNull();
      expect(parseLocaleDecimal("1,500.50", locale)).toBeNull();
      expect(parseLocaleDecimal("1e3", locale)).toBeNull();
      expect(parseLocaleDecimal("$10", locale)).toBeNull();
    },
  );

  it("accepts a de-DE comma decimal and rejects grouping", () => {
    expect(parseLocaleDecimal("1,5", "de-DE")).toBe("1.5");
    expect(parseLocaleDecimal("25,5", "de-DE")).toBe("25.5");
    expect(parseLocaleDecimal("1.500", "de-DE")).toBeNull();
    expect(parseLocaleDecimal("1.5", "de-DE")).toBeNull();
  });
});
