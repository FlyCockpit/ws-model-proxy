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

  it("rejects a comma decimal in en-US instead of reading it as 1.5 or 15", () => {
    expect(parseLocaleDecimal("1,5", "en-US")).toBeNull();
    expect(parseLocaleDecimal("0,5", "en-US")).toBeNull();
    expect(parseLocaleDecimal(",5", "en-US")).toBeNull();
  });

  it("documents fr-FR: comma decimal, narrow-NBSP grouping rejected, ASCII dot accepted", () => {
    expect(localeNumberParts("fr-FR")).toEqual({ decimal: ",", grouping: "\u202f" });
    expect(parseLocaleDecimal("1,5", "fr-FR")).toBe("1.5");
    // The fr-FR group separator is U+202F; grouping-shaped input is refused.
    expect(parseLocaleDecimal("1\u202f500", "fr-FR")).toBeNull();
    expect(parseLocaleDecimal("1\u202f500,5", "fr-FR")).toBeNull();
    // A plain NBSP or ASCII space is not the locale separator, but the
    // number shape check still refuses it.
    expect(parseLocaleDecimal("1\u00a0500", "fr-FR")).toBeNull();
    expect(parseLocaleDecimal("1 500", "fr-FR")).toBeNull();
    // Two decimal separators are refused.
    expect(parseLocaleDecimal("1,5,0", "fr-FR")).toBeNull();
    // fr-FR does not group with ".", so an ASCII dot decimal is accepted as-is.
    expect(parseLocaleDecimal("1.5", "fr-FR")).toBe("1.5");
  });

  it.each(["en-US", "es-MX", "de-DE"] as const)("rejects a lone sign in %s", (locale) => {
    expect(parseLocaleDecimal("-", locale)).toBeNull();
    expect(parseLocaleDecimal("+", locale)).toBeNull();
    expect(parseLocaleDecimal("+.", locale)).toBeNull();
    expect(parseLocaleDecimal(".", locale)).toBeNull();
  });

  it("keeps a sign on an otherwise valid number for the caller's range check", () => {
    expect(parseLocaleDecimal("-1.5", "en-US")).toBe("-1.5");
    expect(parseLocaleDecimal("+2", "es-MX")).toBe("+2");
    expect(parseLocaleDecimal("-1,5", "de-DE")).toBe("-1.5");
  });
});
